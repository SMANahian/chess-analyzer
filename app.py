import os
import io
import json
import chess
import chess.pgn
import chess.engine
import threading
from flask import Flask, render_template, request, redirect, url_for, session
from werkzeug.security import generate_password_hash, check_password_hash

DATABASE_DIR = 'database'
USERS_FILE = os.path.join(DATABASE_DIR, 'users.json')
STOCKFISH_PATH = './stockfish'
ANALYSIS_DEPTH = 10
OPENING_MOVES_LIMIT = 6
MAX_GAMES_PER_UPLOAD = 150
MAX_FILE_SIZE_MB = 2
MISTAKE_THRESHOLD_CP = 50
TOP_MOVE_THRESHOLD_CP = 30

app = Flask(__name__, static_folder='assets')
app.secret_key = os.environ.get('SECRET_KEY', 'secret')
app.config['MAX_CONTENT_LENGTH'] = MAX_FILE_SIZE_MB * 1024 * 1024


def user_dir():
    return os.path.join(DATABASE_DIR, session['username'])


def load_users():
    if os.path.exists(USERS_FILE):
        with open(USERS_FILE) as f:
            return json.load(f)
    return {}


def save_users(users):
    os.makedirs(DATABASE_DIR, exist_ok=True)
    with open(USERS_FILE, 'w') as f:
        json.dump(users, f)


def clean_and_merge_pgn(file_storage, dest_path):
    data = file_storage.read().decode('utf-8', 'ignore')
    pgn_io = io.StringIO(data)
    games = []
    for _ in range(MAX_GAMES_PER_UPLOAD):
        game = chess.pgn.read_game(pgn_io)
        if game is None:
            break
        board = game.board()
        new_game = chess.pgn.Game()
        node = new_game
        for i, move in enumerate(game.mainline_moves()):
            if i >= OPENING_MOVES_LIMIT:
                break
            node = node.add_variation(move)
            board.push(move)
        exporter = chess.pgn.StringExporter(headers=True, variations=False, comments=False)
        games.append(new_game.accept(exporter))
    with open(dest_path, 'a') as f:
        for g in games:
            f.write(g + '\n\n')


def analyze_pgn(paths):
    """Analyze one or more PGN files and return a list of common mistakes."""
    mistakes = {}
    engine = chess.engine.SimpleEngine.popen_uci(STOCKFISH_PATH)
    for path in paths:
        if not os.path.exists(path):
            continue
        with open(path) as pgn:
            while True:
                game = chess.pgn.read_game(pgn)
                if game is None:
                    break
                board = game.board()
                for i, move in enumerate(game.mainline_moves()):
                    if i >= OPENING_MOVES_LIMIT:
                        break
                    fen = board.fen()
                    try:
                        infos = engine.analyse(board, chess.engine.Limit(depth=ANALYSIS_DEPTH), multipv=5)
                    except chess.engine.EngineError:
                        board.push(move)
                        continue
                    best_score = infos[0]['score'].white().score(mate_score=10000)
                    top_moves = []
                    for info in infos:
                        mv = info['pv'][0]
                        mv_score = info['score'].white().score(mate_score=10000)
                        if best_score - mv_score <= TOP_MOVE_THRESHOLD_CP:
                            top_moves.append(mv.uci())
                    score_before = best_score
                    board.push(move)
                    info_after = engine.analyse(board, chess.engine.Limit(depth=ANALYSIS_DEPTH))
                    score_after = info_after['score'].white().score(mate_score=10000)
                    is_white_turn = board.turn == chess.BLACK
                    cp_loss = score_before - score_after if is_white_turn else score_after - score_before
                    if cp_loss > MISTAKE_THRESHOLD_CP:
                        key = (fen, move.uci())
                        if key not in mistakes:
                            mistakes[key] = {
                                'fen': fen,
                                'user_move': move.uci(),
                                'top_moves': top_moves,
                                'game_count': 0,
                                'total_cp_loss': 0
                            }
                        mistakes[key]['game_count'] += 1
                        mistakes[key]['total_cp_loss'] += cp_loss
    engine.quit()
    final_list = []
    for m in mistakes.values():
        if m['game_count'] > 0:
            m['avg_cp_loss'] = round(m['total_cp_loss'] / m['game_count'])
            final_list.append(m)
    final_list.sort(key=lambda x: (x['game_count'], x['avg_cp_loss']), reverse=True)
    return final_list


def analyze_async(paths, analysis_file, flag_file):
    """Run analyze_pgn in a background thread and remove the flag when done."""

    def task():
        mistakes = analyze_pgn(paths)
        with open(analysis_file, 'w') as f:
            json.dump(mistakes, f)
        if os.path.exists(flag_file):
            os.remove(flag_file)

    threading.Thread(target=task, daemon=True).start()


@app.route('/')
def home():
    if 'username' in session:
        return redirect(url_for('upload'))
    return redirect(url_for('login'))


@app.route('/register', methods=['GET', 'POST'])
def register():
    if request.method == 'POST':
        username = request.form['username']
        email = request.form['email']
        password = request.form['password']
        users = load_users()
        if username in users:
            return render_template('register.html', error='Username already exists')
        users[username] = {
            'email': email,
            'password': generate_password_hash(password)
        }
        save_users(users)
        session['username'] = username
        session['email'] = email
        os.makedirs(user_dir(), exist_ok=True)
        return redirect(url_for('upload'))
    return render_template('register.html')


@app.route('/login', methods=['GET', 'POST'])
def login():
    if request.method == 'POST':
        username = request.form['username']
        password = request.form['password']
        users = load_users()
        user = users.get(username)
        if user and check_password_hash(user['password'], password):
            session['username'] = username
            session['email'] = user['email']
            os.makedirs(user_dir(), exist_ok=True)
            return redirect(url_for('upload'))
        return render_template('login.html', error='Invalid credentials')
    return render_template('login.html')


@app.route('/logout')
def logout():
    session.clear()
    return redirect(url_for('login'))


@app.route('/upload', methods=['GET', 'POST'])
def upload():
    if 'username' not in session:
        return redirect(url_for('login'))
    if request.method == 'POST':
        white_file = request.files.get('white_pgn')
        black_file = request.files.get('black_pgn')
        if not white_file and not black_file:
            return render_template('upload.html', username=session.get('username'), error='Please provide at least one PGN file.')
        if white_file and white_file.filename.lower().endswith('.pgn'):
            dest = os.path.join(user_dir(), f"{session['username']}_white.pgn")
            clean_and_merge_pgn(white_file, dest)
        if black_file and black_file.filename.lower().endswith('.pgn'):
            dest = os.path.join(user_dir(), f"{session['username']}_black.pgn")
            clean_and_merge_pgn(black_file, dest)
        return redirect(url_for('train'))
    return render_template('upload.html', username=session.get('username'), error=None)


@app.route('/train', methods=['GET', 'POST'])
def train():
    if 'username' not in session:
        return redirect(url_for('login'))
    user_pgn_white = os.path.join(user_dir(), f"{session['username']}_white.pgn")
    user_pgn_black = os.path.join(user_dir(), f"{session['username']}_black.pgn")
    analysis_file = os.path.join(user_dir(), f"{session['username']}_analysis.json")
    processing_flag = os.path.join(user_dir(), 'analysis.processing')
    if request.method == 'POST':
        paths = []
        if os.path.exists(user_pgn_white):
            paths.append(user_pgn_white)
        if os.path.exists(user_pgn_black):
            paths.append(user_pgn_black)
        if paths:
            open(processing_flag, 'w').close()
            analyze_async(paths, analysis_file, processing_flag)
        return redirect(url_for('analysis'))
    return render_template('train.html')


@app.route('/analysis')
def analysis():
    if 'username' not in session:
        return redirect(url_for('login'))
    analysis_file = os.path.join(user_dir(), f"{session['username']}_analysis.json")
    processing_flag = os.path.join(user_dir(), 'analysis.processing')
    mistakes = []
    processing = False
    if os.path.exists(analysis_file):
        with open(analysis_file) as f:
            mistakes = json.load(f)
    elif os.path.exists(processing_flag):
        processing = True
    return render_template('analysis.html', mistakes=mistakes, processing=processing)


@app.route('/delete_mistake/<int:index>', methods=['POST'])
def delete_mistake(index):
    if 'username' not in session:
        return ('', 403)
    analysis_file = os.path.join(user_dir(), f"{session['username']}_analysis.json")
    if not os.path.exists(analysis_file):
        return ('', 404)
    with open(analysis_file) as f:
        mistakes = json.load(f)
    if 0 <= index < len(mistakes):
        mistakes.pop(index)
        with open(analysis_file, 'w') as f:
            json.dump(mistakes, f)
    return ('', 204)


if __name__ == '__main__':
    os.makedirs(DATABASE_DIR, exist_ok=True)
    app.run(debug=True)
