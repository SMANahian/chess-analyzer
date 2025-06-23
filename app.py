import os
import chess
import chess.pgn
import chess.engine
from flask import Flask, render_template, request, redirect, url_for

# --- Configuration ---
UPLOAD_FOLDER = 'uploads'
STOCKFISH_PATH = './stockfish' # Make sure this path is correct
ANALYSIS_DEPTH = 14 # Engine depth. Higher is stronger but slower.
OPENING_MOVES_LIMIT = 4 # Analyze the first 20 moves of each game
MISTAKE_THRESHOLD_CP = 50 # Minimum centipawn loss to be considered a mistake

app = Flask(__name__)
app.config['UPLOAD_FOLDER'] = UPLOAD_FOLDER

# --- Flask Routes ---
@app.route('/')
def index():
    return render_template('index.html')

@app.route('/analyze', methods=['POST'])
def analyze():
    if 'pgn_file' not in request.files:
        return redirect(url_for('index'))

    file = request.files['pgn_file']
    if file.filename == '' or not file.filename.lower().endswith('.pgn'):
        return redirect(url_for('index'))

    filepath = os.path.join(app.config['UPLOAD_FOLDER'], file.filename)
    file.save(filepath)

    # --- Start Analysis ---
    mistakes_aggregator = {} # Key: (FEN, user_move), Value: {details}
    engine = chess.engine.SimpleEngine.popen_uci(STOCKFISH_PATH)
    
    with open(filepath) as pgn:
        while True:
            try:
                game = chess.pgn.read_game(pgn)
            except (ValueError, KeyError):
                # Handle potential parsing errors in malformed PGNs
                continue
                
            if game is None:
                break # End of PGN file

            board = game.board()
            for i, move in enumerate(game.mainline_moves()):
                if i >= OPENING_MOVES_LIMIT:
                    break

                position_fen = board.fen()
                
                try:
                    # Get evaluation and best move *before* the user's move
                    info_before = engine.analyse(board, chess.engine.Limit(depth=ANALYSIS_DEPTH))
                    score_before = info_before["score"].white().score(mate_score=10000)
                    best_move = info_before['pv'][0]
                except (chess.engine.EngineError, IndexError):
                    board.push(move)
                    continue # Skip this move if engine fails

                # Make the user's move and get the new evaluation
                board.push(move)
                info_after = engine.analyse(board, chess.engine.Limit(depth=ANALYSIS_DEPTH))
                score_after = info_after["score"].white().score(mate_score=10000)

                # Calculate centipawn loss from the correct perspective
                is_white_turn = (board.turn == chess.BLACK) # Turn has already switched
                cp_loss = score_before - score_after if is_white_turn else score_after - score_before

                if cp_loss > MISTAKE_THRESHOLD_CP:
                    mistake_key = (position_fen, move.uci())
                    
                    if mistake_key not in mistakes_aggregator:
                        mistakes_aggregator[mistake_key] = {
                            'fen': position_fen,
                            'user_move': move.uci(),
                            'best_move': best_move.uci(),
                            'game_count': 0,
                            'total_cp_loss': 0
                        }
                    
                    mistakes_aggregator[mistake_key]['game_count'] += 1
                    mistakes_aggregator[mistake_key]['total_cp_loss'] += cp_loss

    engine.quit()
    # --- End Analysis ---

    # Convert the aggregated dictionary into a list for rendering
    final_mistakes_list = []
    for mistake in mistakes_aggregator.values():
        # Only show mistakes that were made more than once
        if mistake['game_count'] > 1:
            mistake['avg_cp_loss'] = round(mistake['total_cp_loss'] / mistake['game_count'])
            final_mistakes_list.append(mistake)
    
    # Sort by how often the mistake was made, then by average severity
    final_mistakes_list.sort(key=lambda x: (x['game_count'], x['avg_cp_loss']), reverse=True)

    return render_template('results.html', mistakes=final_mistakes_list)

if __name__ == '__main__':
    os.makedirs(UPLOAD_FOLDER, exist_ok=True)
    app.run(debug=True)