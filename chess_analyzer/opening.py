"""ECO opening name lookup.

Builds an in-memory index at import time (~300 bundled lines).
Lookup is O(1) by position key. Used during analysis to tag mistakes
with the opening they occurred in.
"""
from __future__ import annotations

import io
from typing import Optional, Tuple

import chess
import chess.pgn


def _pos_key(board: chess.Board) -> str:
    ep = chess.square_name(board.ep_square) if board.ep_square else "-"
    return f"{board.board_fen()} {'w' if board.turn else 'b'} {board.castling_xfen()} {ep}"


# Compact ECO dataset: ECO_CODE <TAB> NAME <TAB> PGN_MOVES
# ~300 lines covering the most common openings at club/online level.
_ECO_TSV = """\
A00\tPolish Opening\t1. b4
A00\tNimzo-Larsen Attack\t1. b3
A00\tVan't Kruijs Opening\t1. e3
A00\tHungarian Opening\t1. g3
A02\tBird's Opening\t1. f4
A03\tBird's Opening: Dutch Variation\t1. f4 d5
A04\tRéti Opening\t1. Nf3
A05\tRéti Opening\t1. Nf3 Nf6
A06\tRéti Opening: Nimzowitsch-Larsen Variation\t1. Nf3 d5 2. b3
A07\tKing's Indian Attack\t1. Nf3 d5 2. g3
A08\tKing's Indian Attack\t1. Nf3 d5 2. g3 Nf6 3. Bg2
A09\tRéti Opening: Advance Variation\t1. Nf3 d5 2. c4
A10\tEnglish Opening\t1. c4
A11\tEnglish Opening: Caro-Kann Defensive System\t1. c4 c6
A12\tEnglish Opening: Caro-Kann Defensive System\t1. c4 c6 2. Nf3 d5 3. b3
A13\tEnglish Opening: Agincourt Defense\t1. c4 e6
A14\tEnglish Opening: Agincourt Defense, Neo-Catalan Declined\t1. c4 e6 2. Nf3 d5 3. g3 Nf6 4. Bg2 Be7 5. O-O
A15\tEnglish Opening: Anglo-Indian Defense\t1. c4 Nf6
A16\tEnglish Opening: Anglo-Indian Defense, Queen's Knight Variation\t1. c4 Nf6 2. Nc3
A17\tEnglish Opening: Anglo-Indian Defense, Nimzowitsch-English Opening\t1. c4 Nf6 2. Nc3 e6
A20\tEnglish Opening: King's English Variation\t1. c4 e5
A21\tEnglish Opening: King's English Variation\t1. c4 e5 2. Nc3
A22\tEnglish Opening: King's English Variation, Two Knights\t1. c4 e5 2. Nc3 Nf6
A25\tEnglish Opening: King's English Variation, Four Knights\t1. c4 e5 2. Nc3 Nc6
A29\tEnglish Opening: King's English Variation, Four Knights, Kingside Fianchetto\t1. c4 e5 2. Nc3 Nc6 3. Nf3 Nf6 4. g3
A30\tEnglish Opening: Symmetrical Variation\t1. c4 c5
A31\tEnglish Opening: Symmetrical Variation, Anti-Benoni Variation\t1. c4 c5 2. Nf3 Nf6 3. d4
A34\tEnglish Opening: Symmetrical Variation, Rubinstein Variation\t1. c4 c5 2. Nc3
A40\tQueen's Pawn Game\t1. d4
A41\tQueen's Pawn Game: Zukertort Variation\t1. d4 d6
A42\tModern Defense: Averbakh System\t1. d4 g6 2. c4 Bg7 3. Nc3 d6 4. e4
A43\tBenoni Defense: Old Benoni\t1. d4 c5
A44\tBenoni Defense: Old Benoni, Czech Benoni\t1. d4 c5 2. d5 e5
A45\tTrompowsky Attack\t1. d4 Nf6 2. Bg5
A46\tTorre Attack\t1. d4 Nf6 2. Nf3 e6 3. Bg5
A47\tQueen's Indian Defense: Marienbad System\t1. d4 Nf6 2. Nf3 b6
A48\tKing's Indian Defense: Orthodox Variation\t1. d4 Nf6 2. Nf3 g6
A49\tKing's Indian Defense: Fianchetto Variation, without Nc3\t1. d4 Nf6 2. Nf3 g6 3. g3
A50\tBenoni Defense: Indian Spring System\t1. d4 Nf6 2. c4
A51\tBudapest Gambit\t1. d4 Nf6 2. c4 e5
A52\tBudapest Gambit: Rubinstein Variation\t1. d4 Nf6 2. c4 e5 3. dxe5 Ng4
A53\tOld Indian Defense\t1. d4 Nf6 2. c4 d6
A57\tBenoni Defense: Taimanov Variation\t1. d4 Nf6 2. c4 c5 3. d5 b5
A60\tBenoni Defense\t1. d4 Nf6 2. c4 c5 3. d5 e6
A65\tBenoni Defense: King's Pawn Line\t1. d4 Nf6 2. c4 c5 3. d5 e6 4. Nc3 exd5 5. cxd5 d6 6. e4
A70\tBenoni Defense: Classical Variation\t1. d4 Nf6 2. c4 c5 3. d5 e6 4. Nc3 exd5 5. cxd5 d6 6. e4 g6 7. Nf3
A80\tDutch Defense\t1. d4 f5
A83\tDutch Defense: Staunton Gambit\t1. d4 f5 2. e4
A84\tDutch Defense: Normal Variation\t1. d4 f5 2. c4
A85\tDutch Defense: with c4 and Nc3\t1. d4 f5 2. c4 Nf6 3. Nc3
A86\tDutch Defense: Leningrad Variation\t1. d4 f5 2. c4 Nf6 3. g3
A87\tDutch Defense: Leningrad Variation, Main Line\t1. d4 f5 2. c4 Nf6 3. g3 g6 4. Bg2 Bg7 5. Nf3
A90\tDutch Defense: Classical Variation\t1. d4 f5 2. c4 Nf6 3. g3 e6 4. Bg2 Be7
B00\tKing's Pawn Opening\t1. e4
B01\tScandinavian Defense\t1. e4 d5
B01\tScandinavian Defense: Mieses-Kotroc Variation\t1. e4 d5 2. exd5 Qxd5 3. Nc3 Qa5
B01\tScandinavian Defense: Main Line\t1. e4 d5 2. exd5 Nf6
B02\tAlekhine Defense\t1. e4 Nf6
B03\tAlekhine Defense: Exchange Variation\t1. e4 Nf6 2. e5 Nd5 3. d4 d6 4. c4 Nb6 5. exd6
B04\tAlekhine Defense: Modern Variation\t1. e4 Nf6 2. e5 Nd5 3. d4 d6 4. Nf3
B05\tAlekhine Defense: Modern Variation, Alburt Variation\t1. e4 Nf6 2. e5 Nd5 3. d4 d6 4. Nf3 Bg4
B06\tModern Defense\t1. e4 g6
B07\tPirc Defense\t1. e4 d6 2. d4 Nf6
B08\tPirc Defense: Classical Variation\t1. e4 d6 2. d4 Nf6 3. Nc3 g6 4. Nf3
B09\tPirc Defense: Austrian Attack\t1. e4 d6 2. d4 Nf6 3. Nc3 g6 4. f4
B10\tCaro-Kann Defense\t1. e4 c6
B12\tCaro-Kann Defense: Advance Variation\t1. e4 c6 2. d4 d5 3. e5
B13\tCaro-Kann Defense: Exchange Variation\t1. e4 c6 2. d4 d5 3. exd5 cxd5
B14\tCaro-Kann Defense: Panov Attack\t1. e4 c6 2. d4 d5 3. exd5 cxd5 4. c4
B15\tCaro-Kann Defense: Gurgenidze Variation\t1. e4 c6 2. d4 d5 3. Nc3
B16\tCaro-Kann Defense: Bronstein-Larsen Variation\t1. e4 c6 2. d4 d5 3. Nc3 dxe4 4. Nxe4 Nf6 5. Nxf6+ gxf6
B17\tCaro-Kann Defense: Steinitz Variation\t1. e4 c6 2. d4 d5 3. Nc3 dxe4 4. Nxe4 Nd7
B18\tCaro-Kann Defense: Classical Variation\t1. e4 c6 2. d4 d5 3. Nc3 dxe4 4. Nxe4 Bf5
B19\tCaro-Kann Defense: Classical Variation, Main Line\t1. e4 c6 2. d4 d5 3. Nc3 dxe4 4. Nxe4 Bf5 5. Ng3 Bg6 6. h4 h6 7. Nf3 Nd7
B20\tSicilian Defense\t1. e4 c5
B21\tSicilian Defense: Grand Prix Attack\t1. e4 c5 2. f4
B22\tSicilian Defense: Alapin Variation\t1. e4 c5 2. c3
B23\tSicilian Defense: Closed Variation\t1. e4 c5 2. Nc3
B27\tSicilian Defense: Hyperaccelerated Dragon\t1. e4 c5 2. Nf3 g6
B28\tSicilian Defense: O'Kelly Variation\t1. e4 c5 2. Nf3 a6
B29\tSicilian Defense: Nimzowitsch Variation\t1. e4 c5 2. Nf3 Nf6
B30\tSicilian Defense: Old Sicilian\t1. e4 c5 2. Nf3 Nc6
B31\tSicilian Defense: Nimzowitsch-Rossolimo Attack\t1. e4 c5 2. Nf3 Nc6 3. Bb5
B32\tSicilian Defense: Open Variation, Löwenthal Variation\t1. e4 c5 2. Nf3 Nc6 3. d4 cxd4 4. Nxd4 e5
B33\tSicilian Defense: Open Variation\t1. e4 c5 2. Nf3 Nc6 3. d4 cxd4 4. Nxd4
B40\tSicilian Defense: Pin Variation\t1. e4 c5 2. Nf3 e6
B41\tSicilian Defense: Kan Variation\t1. e4 c5 2. Nf3 e6 3. d4 cxd4 4. Nxd4 a6
B42\tSicilian Defense: Kan Variation, Polugaevsky Variation\t1. e4 c5 2. Nf3 e6 3. d4 cxd4 4. Nxd4 a6 5. Bd3
B44\tSicilian Defense: Taimanov Variation\t1. e4 c5 2. Nf3 e6 3. d4 cxd4 4. Nxd4 Nc6
B45\tSicilian Defense: Taimanov Variation, American Attack\t1. e4 c5 2. Nf3 e6 3. d4 cxd4 4. Nxd4 Nc6 5. Nc3
B48\tSicilian Defense: Taimanov Variation, Bastrikov Variation\t1. e4 c5 2. Nf3 e6 3. d4 cxd4 4. Nxd4 Nc6 5. Nc3 Qc7
B50\tSicilian Defense: Modern Variations\t1. e4 c5 2. Nf3 d6
B51\tSicilian Defense: Moscow Variation\t1. e4 c5 2. Nf3 d6 3. Bb5+
B52\tSicilian Defense: Moscow Variation, Ridge Variation\t1. e4 c5 2. Nf3 d6 3. Bb5+ Bd7
B54\tSicilian Defense: Open, Prins Variation\t1. e4 c5 2. Nf3 d6 3. d4 cxd4 4. Nxd4
B56\tSicilian Defense: Classical Variation\t1. e4 c5 2. Nf3 d6 3. d4 cxd4 4. Nxd4 Nf6 5. Nc3
B57\tSicilian Defense: Classical Variation, Sozin Variation\t1. e4 c5 2. Nf3 d6 3. d4 cxd4 4. Nxd4 Nf6 5. Nc3 Nc6 6. Bc4
B58\tSicilian Defense: Classical Variation\t1. e4 c5 2. Nf3 d6 3. d4 cxd4 4. Nxd4 Nf6 5. Nc3 Nc6
B60\tSicilian Defense: Richter-Rauzer Variation\t1. e4 c5 2. Nf3 d6 3. d4 cxd4 4. Nxd4 Nf6 5. Nc3 Nc6 6. Bg5
B62\tSicilian Defense: Richter-Rauzer Variation, Margate Variation\t1. e4 c5 2. Nf3 d6 3. d4 cxd4 4. Nxd4 Nf6 5. Nc3 Nc6 6. Bg5 e6 7. Qd2
B65\tSicilian Defense: Richter-Rauzer Variation, 7...Be7\t1. e4 c5 2. Nf3 d6 3. d4 cxd4 4. Nxd4 Nf6 5. Nc3 Nc6 6. Bg5 e6 7. Qd2 Be7
B70\tSicilian Defense: Dragon Variation\t1. e4 c5 2. Nf3 d6 3. d4 cxd4 4. Nxd4 Nf6 5. Nc3 g6
B72\tSicilian Defense: Dragon Variation, Classical Variation\t1. e4 c5 2. Nf3 d6 3. d4 cxd4 4. Nxd4 Nf6 5. Nc3 g6 6. Be3
B76\tSicilian Defense: Dragon Variation, Yugoslav Attack\t1. e4 c5 2. Nf3 d6 3. d4 cxd4 4. Nxd4 Nf6 5. Nc3 g6 6. Be3 Bg7 7. f3
B78\tSicilian Defense: Dragon Variation, Yugoslav Attack, 9.Bc4\t1. e4 c5 2. Nf3 d6 3. d4 cxd4 4. Nxd4 Nf6 5. Nc3 g6 6. Be3 Bg7 7. f3 O-O 8. Qd2 Nc6 9. Bc4
B80\tSicilian Defense: Scheveningen Variation\t1. e4 c5 2. Nf3 d6 3. d4 cxd4 4. Nxd4 Nf6 5. Nc3 e6
B81\tSicilian Defense: Scheveningen Variation, Keres Attack\t1. e4 c5 2. Nf3 d6 3. d4 cxd4 4. Nxd4 Nf6 5. Nc3 e6 6. g4
B84\tSicilian Defense: Scheveningen Variation, Classical Variation\t1. e4 c5 2. Nf3 d6 3. d4 cxd4 4. Nxd4 Nf6 5. Nc3 e6 6. Be2
B85\tSicilian Defense: Scheveningen Variation, Classical Variation\t1. e4 c5 2. Nf3 d6 3. d4 cxd4 4. Nxd4 Nf6 5. Nc3 e6 6. Be2 Nc6
B90\tSicilian Defense: Najdorf Variation\t1. e4 c5 2. Nf3 d6 3. d4 cxd4 4. Nxd4 Nf6 5. Nc3 a6
B91\tSicilian Defense: Najdorf, English Attack\t1. e4 c5 2. Nf3 d6 3. d4 cxd4 4. Nxd4 Nf6 5. Nc3 a6 6. Rg1
B92\tSicilian Defense: Najdorf, Opocensky Variation\t1. e4 c5 2. Nf3 d6 3. d4 cxd4 4. Nxd4 Nf6 5. Nc3 a6 6. Be2
B93\tSicilian Defense: Najdorf, Amsterdam Variation\t1. e4 c5 2. Nf3 d6 3. d4 cxd4 4. Nxd4 Nf6 5. Nc3 a6 6. f4
B94\tSicilian Defense: Najdorf, Poisoned Pawn Variation\t1. e4 c5 2. Nf3 d6 3. d4 cxd4 4. Nxd4 Nf6 5. Nc3 a6 6. Bg5
B96\tSicilian Defense: Najdorf, Poisoned Pawn\t1. e4 c5 2. Nf3 d6 3. d4 cxd4 4. Nxd4 Nf6 5. Nc3 a6 6. Bg5 e6 7. f4
B97\tSicilian Defense: Najdorf, Poisoned Pawn Accepted\t1. e4 c5 2. Nf3 d6 3. d4 cxd4 4. Nxd4 Nf6 5. Nc3 a6 6. Bg5 e6 7. f4 Qb6
C00\tFrench Defense\t1. e4 e6
C01\tFrench Defense: Exchange Variation\t1. e4 e6 2. d4 d5 3. exd5
C02\tFrench Defense: Advance Variation\t1. e4 e6 2. d4 d5 3. e5
C03\tFrench Defense: Tarrasch Variation\t1. e4 e6 2. d4 d5 3. Nd2
C06\tFrench Defense: Tarrasch Variation, Main Line\t1. e4 e6 2. d4 d5 3. Nd2 Nf6 4. e5 Nfd7 5. Bd3 c5 6. c3 Nc6
C10\tFrench Defense: Rubinstein Variation\t1. e4 e6 2. d4 d5 3. Nc3 dxe4
C11\tFrench Defense: Classical Variation\t1. e4 e6 2. d4 d5 3. Nc3 Nf6
C13\tFrench Defense: Classical Variation, Richter Attack\t1. e4 e6 2. d4 d5 3. Nc3 Nf6 4. Bg5
C14\tFrench Defense: Classical Variation, Chatard-Alekhine Attack\t1. e4 e6 2. d4 d5 3. Nc3 Nf6 4. Bg5 Be7 5. e5
C15\tFrench Defense: Winawer Variation\t1. e4 e6 2. d4 d5 3. Nc3 Bb4
C16\tFrench Defense: Winawer Variation, Advance Variation\t1. e4 e6 2. d4 d5 3. Nc3 Bb4 4. e5
C17\tFrench Defense: Winawer Variation, Advance, 5. a3\t1. e4 e6 2. d4 d5 3. Nc3 Bb4 4. e5 c5 5. a3
C18\tFrench Defense: Winawer Variation, Main Line\t1. e4 e6 2. d4 d5 3. Nc3 Bb4 4. e5 c5 5. a3 Bxc3+
C20\tKing's Pawn Game: Wayward Queen Attack\t1. e4 e5 2. Qh5
C21\tCenter Game\t1. e4 e5 2. d4
C22\tCenter Game: Accepted\t1. e4 e5 2. d4 exd4 3. Qxd4
C23\tBishop's Opening\t1. e4 e5 2. Bc4
C24\tBishop's Opening: Berlin Defense\t1. e4 e5 2. Bc4 Nf6
C25\tVienna Game\t1. e4 e5 2. Nc3
C26\tVienna Game: Vienna Gambit\t1. e4 e5 2. Nc3 Nf6 3. f4
C27\tVienna Game: Frankenstein-Dracula Variation\t1. e4 e5 2. Nc3 Nf6 3. Bc4 Nxe4
C28\tVienna Game: Stanley Variation\t1. e4 e5 2. Nc3 Nc6
C29\tVienna Game: Stanley Variation, Vienna Gambit\t1. e4 e5 2. Nc3 Nc6 3. f4
C30\tKing's Gambit\t1. e4 e5 2. f4
C31\tKing's Gambit Declined: Falkbeer Countergambit\t1. e4 e5 2. f4 d5
C33\tKing's Gambit Accepted: Bishop's Gambit\t1. e4 e5 2. f4 exf4 3. Bc4
C34\tKing's Gambit Accepted: Fischer Defense\t1. e4 e5 2. f4 exf4 3. Nf3
C40\tKing's Pawn Game: Gunderam Defense\t1. e4 e5 2. Nf3
C41\tPhilidor Defense\t1. e4 e5 2. Nf3 d6
C42\tPetrov Defense\t1. e4 e5 2. Nf3 Nf6
C43\tPetrov Defense: Modern Attack\t1. e4 e5 2. Nf3 Nf6 3. d4
C44\tKing's Pawn Game: Scotch Game\t1. e4 e5 2. Nf3 Nc6
C45\tScotch Game\t1. e4 e5 2. Nf3 Nc6 3. d4
C46\tThree Knights Opening\t1. e4 e5 2. Nf3 Nc6 3. Nc3
C47\tFour Knights Game\t1. e4 e5 2. Nf3 Nc6 3. Nc3 Nf6
C48\tFour Knights Game: Spanish Variation\t1. e4 e5 2. Nf3 Nc6 3. Nc3 Nf6 4. Bb5
C50\tItalian Game\t1. e4 e5 2. Nf3 Nc6 3. Bc4
C51\tItalian Game: Evans Gambit\t1. e4 e5 2. Nf3 Nc6 3. Bc4 Bc5 4. b4
C52\tItalian Game: Evans Gambit, Waller Attack\t1. e4 e5 2. Nf3 Nc6 3. Bc4 Bc5 4. b4 Bxb4 5. c3
C53\tItalian Game: Classical Variation\t1. e4 e5 2. Nf3 Nc6 3. Bc4 Bc5 4. c3
C54\tItalian Game: Giuoco Piano\t1. e4 e5 2. Nf3 Nc6 3. Bc4 Bc5 4. c3 Nf6
C55\tItalian Game: Two Knights Defense\t1. e4 e5 2. Nf3 Nc6 3. Bc4 Nf6
C56\tItalian Game: Two Knights Defense, Modern Bishop's Opening\t1. e4 e5 2. Nf3 Nc6 3. Bc4 Nf6 4. d4
C57\tItalian Game: Two Knights Defense, Traxler Counterattack\t1. e4 e5 2. Nf3 Nc6 3. Bc4 Nf6 4. Ng5
C58\tItalian Game: Two Knights Defense, Morphy Variation\t1. e4 e5 2. Nf3 Nc6 3. Bc4 Nf6 4. Ng5 d5 5. exd5 Na5
C60\tRuy López\t1. e4 e5 2. Nf3 Nc6 3. Bb5
C61\tRuy López: Bird's Defense\t1. e4 e5 2. Nf3 Nc6 3. Bb5 Nd4
C62\tRuy López: Old Steinitz Defense\t1. e4 e5 2. Nf3 Nc6 3. Bb5 d6
C63\tRuy López: Schliemann-Jaenisch Gambit\t1. e4 e5 2. Nf3 Nc6 3. Bb5 f5
C64\tRuy López: Classical Variation\t1. e4 e5 2. Nf3 Nc6 3. Bb5 Bc5
C65\tRuy López: Berlin Defense\t1. e4 e5 2. Nf3 Nc6 3. Bb5 Nf6
C66\tRuy López: Berlin Defense, Closed Variation\t1. e4 e5 2. Nf3 Nc6 3. Bb5 Nf6 4. O-O d6
C67\tRuy López: Berlin Defense, Open Variation\t1. e4 e5 2. Nf3 Nc6 3. Bb5 Nf6 4. O-O Nxe4
C68\tRuy López: Exchange Variation\t1. e4 e5 2. Nf3 Nc6 3. Bb5 a6 4. Bxc6
C70\tRuy López: Morphy Defense\t1. e4 e5 2. Nf3 Nc6 3. Bb5 a6
C72\tRuy López: Morphy Defense, Modern Steinitz Defense\t1. e4 e5 2. Nf3 Nc6 3. Bb5 a6 4. Ba4 d6 5. O-O
C73\tRuy López: Modern Steinitz Defense, Richter Variation\t1. e4 e5 2. Nf3 Nc6 3. Bb5 a6 4. Ba4 d6 5. Bxc6+
C77\tRuy López: Morphy Defense\t1. e4 e5 2. Nf3 Nc6 3. Bb5 a6 4. Ba4 Nf6
C78\tRuy López: Morphy Defense, Archangel Variation\t1. e4 e5 2. Nf3 Nc6 3. Bb5 a6 4. Ba4 Nf6 5. O-O
C79\tRuy López: Morphy Defense, Steinitz Defense Deferred\t1. e4 e5 2. Nf3 Nc6 3. Bb5 a6 4. Ba4 Nf6 5. O-O d6
C80\tRuy López: Open Variation\t1. e4 e5 2. Nf3 Nc6 3. Bb5 a6 4. Ba4 Nf6 5. O-O Nxe4
C84\tRuy López: Closed Variation\t1. e4 e5 2. Nf3 Nc6 3. Bb5 a6 4. Ba4 Nf6 5. O-O Be7
C88\tRuy López: Closed, Anti-Marshall\t1. e4 e5 2. Nf3 Nc6 3. Bb5 a6 4. Ba4 Nf6 5. O-O Be7 6. Re1 b5 7. Bb3
C89\tRuy López: Marshall Attack\t1. e4 e5 2. Nf3 Nc6 3. Bb5 a6 4. Ba4 Nf6 5. O-O Be7 6. Re1 b5 7. Bb3 O-O 8. c3 d5
C90\tRuy López: Closed Variation\t1. e4 e5 2. Nf3 Nc6 3. Bb5 a6 4. Ba4 Nf6 5. O-O Be7 6. Re1 b5 7. Bb3 O-O 8. c3
C92\tRuy López: Closed, Flohr-Zaitsev System\t1. e4 e5 2. Nf3 Nc6 3. Bb5 a6 4. Ba4 Nf6 5. O-O Be7 6. Re1 b5 7. Bb3 O-O 8. c3 d6 9. h3
C94\tRuy López: Breyer Variation\t1. e4 e5 2. Nf3 Nc6 3. Bb5 a6 4. Ba4 Nf6 5. O-O Be7 6. Re1 b5 7. Bb3 O-O 8. c3 d6 9. h3 Nb8
C95\tRuy López: Breyer Variation, Zaitsev Hybrid\t1. e4 e5 2. Nf3 Nc6 3. Bb5 a6 4. Ba4 Nf6 5. O-O Be7 6. Re1 b5 7. Bb3 O-O 8. c3 d6 9. h3 Nb8 10. d4
C96\tRuy López: Chigorin Defense\t1. e4 e5 2. Nf3 Nc6 3. Bb5 a6 4. Ba4 Nf6 5. O-O Be7 6. Re1 b5 7. Bb3 O-O 8. c3 d6 9. h3 Na5
D00\tQueen's Pawn Game: London System\t1. d4 d5
D01\tRichter-Veresov Attack\t1. d4 d5 2. Nc3 Nf6 3. Bg5
D02\tQueen's Pawn Game: Symmetrical Variation\t1. d4 d5 2. Nf3
D04\tQueen's Pawn Game: Colle System\t1. d4 d5 2. Nf3 Nf6 3. e3
D05\tQueen's Pawn Game: Zukertort-Indian Variation\t1. d4 d5 2. Nf3 Nf6 3. e3 e6 4. Bd3
D06\tQueen's Gambit Declined: Austrian Defense\t1. d4 d5 2. c4
D07\tQueen's Gambit Declined: Chigorin Defense\t1. d4 d5 2. c4 Nc6
D08\tQueen's Gambit Declined: Albin Countergambit\t1. d4 d5 2. c4 e5
D10\tSlav Defense\t1. d4 d5 2. c4 c6
D11\tSlav Defense: Quiet Variation\t1. d4 d5 2. c4 c6 3. Nf3
D12\tSlav Defense: Exchange Variation\t1. d4 d5 2. c4 c6 3. Nf3 Nf6 4. e3 Bf5
D15\tSlav Defense: Chameleon Variation\t1. d4 d5 2. c4 c6 3. Nc3 Nf6
D16\tSlav Defense: Alapin Variation\t1. d4 d5 2. c4 c6 3. Nc3 Nf6 4. Nf3 dxc4
D18\tSlav Defense: Czech Variation\t1. d4 d5 2. c4 c6 3. Nc3 Nf6 4. Nf3 dxc4 5. a4 Bf5
D20\tQueen's Gambit Accepted\t1. d4 d5 2. c4 dxc4
D21\tQueen's Gambit Accepted: Slav Gambit\t1. d4 d5 2. c4 dxc4 3. Nf3
D25\tQueen's Gambit Accepted: Janowski-Larsen Variation\t1. d4 d5 2. c4 dxc4 3. Nf3 Nf6 4. e3
D26\tQueen's Gambit Accepted: Classical Variation\t1. d4 d5 2. c4 dxc4 3. Nf3 Nf6 4. e3 e6
D30\tQueen's Gambit Declined\t1. d4 d5 2. c4 e6
D31\tQueen's Gambit Declined: Charousek Variation\t1. d4 d5 2. c4 e6 3. Nc3
D32\tQueen's Gambit Declined: Tarrasch Defense\t1. d4 d5 2. c4 e6 3. Nc3 c5
D34\tQueen's Gambit Declined: Tarrasch, Classical Variation\t1. d4 d5 2. c4 e6 3. Nc3 c5 4. cxd5 exd5 5. Nf3 Nc6 6. g3
D35\tQueen's Gambit Declined: Exchange Variation\t1. d4 d5 2. c4 e6 3. Nc3 Nf6 4. cxd5
D37\tQueen's Gambit Declined: Harrwitz Attack\t1. d4 d5 2. c4 e6 3. Nc3 Nf6 4. Nf3
D38\tQueen's Gambit Declined: Ragozin Defense\t1. d4 d5 2. c4 e6 3. Nc3 Nf6 4. Nf3 Bb4
D40\tQueen's Gambit Declined: Semi-Tarrasch Defense\t1. d4 d5 2. c4 e6 3. Nc3 Nf6 4. Nf3 c5
D43\tQueen's Gambit Declined: Semi-Slav Defense\t1. d4 d5 2. c4 e6 3. Nc3 Nf6 4. Nf3 c6
D44\tQueen's Gambit Declined: Semi-Slav, Anti-Meran Gambit\t1. d4 d5 2. c4 e6 3. Nc3 Nf6 4. Nf3 c6 5. Bg5 dxc4
D45\tQueen's Gambit Declined: Semi-Slav Defense\t1. d4 d5 2. c4 e6 3. Nc3 Nf6 4. Nf3 c6 5. e3
D48\tQueen's Gambit Declined: Semi-Slav, Meran Variation\t1. d4 d5 2. c4 e6 3. Nc3 Nf6 4. Nf3 c6 5. e3 Nbd7 6. Bd3 dxc4 7. Bxc4 b5
D50\tQueen's Gambit Declined: Modern Variation\t1. d4 d5 2. c4 e6 3. Nc3 Nf6 4. Bg5
D53\tQueen's Gambit Declined: Classical Variation\t1. d4 d5 2. c4 e6 3. Nc3 Nf6 4. Bg5 Be7
D56\tQueen's Gambit Declined: Lasker Defense\t1. d4 d5 2. c4 e6 3. Nc3 Nf6 4. Bg5 Be7 5. e3 O-O 6. Nf3 h6 7. Bh4 Ne4
D58\tQueen's Gambit Declined: Tartakower Defense\t1. d4 d5 2. c4 e6 3. Nc3 Nf6 4. Bg5 Be7 5. e3 O-O 6. Nf3 h6 7. Bh4 b6
D70\tGrünfeld Defense: Exchange Variation\t1. d4 Nf6 2. c4 g6 3. Nc3 d5 4. cxd5 Nxd5 5. e4 Nxc3 6. bxc3
D80\tGrünfeld Defense\t1. d4 Nf6 2. c4 g6 3. Nc3 d5
D82\tGrünfeld Defense: Bf4 Variation\t1. d4 Nf6 2. c4 g6 3. Nc3 d5 4. Bf4
D85\tGrünfeld Defense: Exchange Variation\t1. d4 Nf6 2. c4 g6 3. Nc3 d5 4. cxd5
D86\tGrünfeld Defense: Exchange Variation, Classical Variation\t1. d4 Nf6 2. c4 g6 3. Nc3 d5 4. cxd5 Nxd5 5. e4 Nxc3 6. bxc3 Bg7 7. Bc4
D87\tGrünfeld Defense: Exchange Variation, Spassky Variation\t1. d4 Nf6 2. c4 g6 3. Nc3 d5 4. cxd5 Nxd5 5. e4 Nxc3 6. bxc3 Bg7 7. Bc4 c5 8. Ne2
D90\tGrünfeld Defense: Three Knights Variation\t1. d4 Nf6 2. c4 g6 3. Nc3 d5 4. Nf3
D94\tGrünfeld Defense: Closed Variation\t1. d4 Nf6 2. c4 g6 3. Nc3 d5 4. Nf3 Bg7 5. e3
D96\tGrünfeld Defense: Russian Variation\t1. d4 Nf6 2. c4 g6 3. Nc3 d5 4. Nf3 Bg7 5. Qb3
E00\tIndian Game\t1. d4 Nf6 2. c4 e6
E01\tCatalan Opening: Closed\t1. d4 Nf6 2. c4 e6 3. g3
E02\tCatalan Opening: Open Defense\t1. d4 Nf6 2. c4 e6 3. g3 d5 4. Bg2 dxc4
E04\tCatalan Opening: Open Defense\t1. d4 Nf6 2. c4 e6 3. g3 d5 4. Nf3 dxc4
E06\tCatalan Opening: Closed Variation\t1. d4 Nf6 2. c4 e6 3. g3 d5 4. Bg2 Be7 5. Nf3
E10\tIndian Game: Anti-Nimzo-Indian\t1. d4 Nf6 2. c4 e6 3. Nf3
E11\tBogo-Indian Defense\t1. d4 Nf6 2. c4 e6 3. Nf3 Bb4+
E12\tQueen's Indian Defense\t1. d4 Nf6 2. c4 e6 3. Nf3 b6
E15\tQueen's Indian Defense: Nimzowitsch Variation\t1. d4 Nf6 2. c4 e6 3. Nf3 b6 4. g3
E16\tQueen's Indian Defense: Capablanca Variation\t1. d4 Nf6 2. c4 e6 3. Nf3 b6 4. g3 Bb7 5. Bg2 Bb4+
E17\tQueen's Indian Defense: Fianchetto Variation\t1. d4 Nf6 2. c4 e6 3. Nf3 b6 4. g3 Bb7 5. Bg2 Be7
E20\tNimzo-Indian Defense\t1. d4 Nf6 2. c4 e6 3. Nc3 Bb4
E21\tNimzo-Indian Defense: Three Knights Variation\t1. d4 Nf6 2. c4 e6 3. Nc3 Bb4 4. Nf3
E22\tNimzo-Indian Defense: Spielmann Variation\t1. d4 Nf6 2. c4 e6 3. Nc3 Bb4 4. Qb3
E24\tNimzo-Indian Defense: Sämisch Variation\t1. d4 Nf6 2. c4 e6 3. Nc3 Bb4 4. a3
E32\tNimzo-Indian Defense: Classical Variation\t1. d4 Nf6 2. c4 e6 3. Nc3 Bb4 4. Qc2
E34\tNimzo-Indian Defense: Classical Variation, Noa Variation\t1. d4 Nf6 2. c4 e6 3. Nc3 Bb4 4. Qc2 d5
E40\tNimzo-Indian Defense: Normal Variation\t1. d4 Nf6 2. c4 e6 3. Nc3 Bb4 4. e3
E46\tNimzo-Indian Defense: Normal Variation\t1. d4 Nf6 2. c4 e6 3. Nc3 Bb4 4. e3 O-O
E47\tNimzo-Indian Defense: Normal Variation\t1. d4 Nf6 2. c4 e6 3. Nc3 Bb4 4. e3 O-O 5. Bd3
E50\tNimzo-Indian Defense: Normal Variation, 5. Nf3\t1. d4 Nf6 2. c4 e6 3. Nc3 Bb4 4. e3 O-O 5. Nf3
E60\tKing's Indian Defense\t1. d4 Nf6 2. c4 g6
E61\tKing's Indian Defense\t1. d4 Nf6 2. c4 g6 3. Nc3 Bg7
E62\tKing's Indian Defense: Fianchetto Variation\t1. d4 Nf6 2. c4 g6 3. Nc3 Bg7 4. Nf3 d6 5. g3
E63\tKing's Indian Defense: Fianchetto, Panno Variation\t1. d4 Nf6 2. c4 g6 3. Nc3 Bg7 4. Nf3 d6 5. g3 O-O 6. Bg2 Nc6
E70\tKing's Indian Defense: Averbakh Variation\t1. d4 Nf6 2. c4 g6 3. Nc3 Bg7 4. e4
E71\tKing's Indian Defense: Makogonov Variation\t1. d4 Nf6 2. c4 g6 3. Nc3 Bg7 4. e4 d6 5. h3
E76\tKing's Indian Defense: Four Pawns Attack\t1. d4 Nf6 2. c4 g6 3. Nc3 Bg7 4. e4 d6 5. f4
E80\tKing's Indian Defense: Sämisch Variation\t1. d4 Nf6 2. c4 g6 3. Nc3 Bg7 4. e4 d6 5. f3
E85\tKing's Indian Defense: Sämisch, Orthodox Variation\t1. d4 Nf6 2. c4 g6 3. Nc3 Bg7 4. e4 d6 5. f3 O-O 6. Be3 e5
E90\tKing's Indian Defense: Larsen Variation\t1. d4 Nf6 2. c4 g6 3. Nc3 Bg7 4. e4 d6 5. Nf3
E91\tKing's Indian Defense: Orthodox Variation\t1. d4 Nf6 2. c4 g6 3. Nc3 Bg7 4. e4 d6 5. Nf3 O-O 6. Be2
E92\tKing's Indian Defense: Orthodox Variation\t1. d4 Nf6 2. c4 g6 3. Nc3 Bg7 4. e4 d6 5. Nf3 O-O 6. Be2 e5
E94\tKing's Indian Defense: Orthodox Variation\t1. d4 Nf6 2. c4 g6 3. Nc3 Bg7 4. e4 d6 5. Nf3 O-O 6. Be2 e5 7. O-O
E97\tKing's Indian Defense: Orthodox, Aronin-Taimanov Variation\t1. d4 Nf6 2. c4 g6 3. Nc3 Bg7 4. e4 d6 5. Nf3 O-O 6. Be2 e5 7. O-O Nc6
E98\tKing's Indian Defense: Orthodox, Classical System\t1. d4 Nf6 2. c4 g6 3. Nc3 Bg7 4. e4 d6 5. Nf3 O-O 6. Be2 e5 7. O-O Nc6 8. d5 Ne7
"""


def _build_index() -> dict:
    """Play through every opening line, index every intermediate position.
    Deeper lines win; ties keep the first matching label so a generic position
    is not relabeled by an unrelated later branch with the same prefix length.
    """
    index: dict[str, tuple[int, tuple[str, str]]] = {}
    for raw_line in _ECO_TSV.strip().splitlines():
        parts = raw_line.split("\t", 2)
        if len(parts) < 3:
            continue
        code, name, pgn_str = parts
        try:
            game = chess.pgn.read_game(io.StringIO(pgn_str))
            if game is None:
                continue
            board = game.board()
            for depth, move in enumerate(game.mainline_moves(), start=1):
                board.push(move)
                key = _pos_key(board)
                current = index.get(key)
                if current is None or depth > current[0]:
                    index[key] = (depth, (code.strip(), name.strip()))
        except Exception:
            continue
    return {key: value for key, (_, value) in index.items()}


_INDEX: dict[str, tuple[str, str]] = _build_index()


def get_opening(board: chess.Board) -> Optional[Tuple[str, str]]:
    """Return (eco_code, name) for this position, or None."""
    return _INDEX.get(_pos_key(board))
