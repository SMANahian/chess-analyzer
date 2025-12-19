"""Application configuration settings."""
from __future__ import annotations

import os
import re
import secrets
from pathlib import Path

BASE_DIR = Path(__file__).resolve().parent
DATABASE_DIR = Path(os.environ.get("DATABASE_DIR", BASE_DIR / "database"))
USERS_FILE = DATABASE_DIR / "users.json"

# Analysis settings
ANALYSIS_DEPTH = int(os.environ.get("ANALYSIS_DEPTH", "14"))
MULTIPV = int(os.environ.get("MULTIPV", "5"))
OPENING_PLIES_LIMIT = int(os.environ.get("OPENING_PLIES_LIMIT", "20"))
MAX_GAMES_PER_UPLOAD = int(os.environ.get("MAX_GAMES_PER_UPLOAD", "1000"))
MAX_FILE_SIZE_MB = int(os.environ.get("MAX_FILE_SIZE_MB", "2"))
MAX_REQUEST_SIZE_MB = int(os.environ.get("MAX_REQUEST_SIZE_MB", str(MAX_FILE_SIZE_MB * 2)))
MISTAKE_THRESHOLD_CP = int(os.environ.get("MISTAKE_THRESHOLD_CP", "100"))
TOP_MOVE_THRESHOLD_CP = int(os.environ.get("TOP_MOVE_THRESHOLD_CP", "30"))
MIN_PAIR_OCCURRENCES = int(os.environ.get("MIN_PAIR_OCCURRENCES", "2"))
MATE_SCORE_CP = int(os.environ.get("MATE_SCORE_CP", "10000"))

# Validation
USERNAME_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9_.-]{1,31}$")
PASSWORD_MIN_LENGTH = int(os.environ.get("PASSWORD_MIN_LENGTH", "8"))

# Session settings
SECRET_KEY = os.environ.get("SECRET_KEY", secrets.token_hex(32))
SESSION_COOKIE_SECURE = os.environ.get("SESSION_COOKIE_SECURE", "false").lower() == "true"
SESSION_COOKIE_HTTPONLY = True
SESSION_COOKIE_SAMESITE = "Lax"
PERMANENT_SESSION_LIFETIME = int(os.environ.get("SESSION_LIFETIME_HOURS", "24")) * 3600


class Config:
    """Flask application configuration."""
    
    SECRET_KEY = SECRET_KEY
    MAX_CONTENT_LENGTH = MAX_REQUEST_SIZE_MB * 1024 * 1024
    SESSION_COOKIE_SECURE = SESSION_COOKIE_SECURE
    SESSION_COOKIE_HTTPONLY = SESSION_COOKIE_HTTPONLY
    SESSION_COOKIE_SAMESITE = SESSION_COOKIE_SAMESITE
    PERMANENT_SESSION_LIFETIME = PERMANENT_SESSION_LIFETIME
    
    # Custom settings
    DATABASE_DIR = DATABASE_DIR
    USERS_FILE = USERS_FILE
    ANALYSIS_DEPTH = ANALYSIS_DEPTH
    MULTIPV = MULTIPV
    OPENING_PLIES_LIMIT = OPENING_PLIES_LIMIT
    MAX_GAMES_PER_UPLOAD = MAX_GAMES_PER_UPLOAD
    MAX_FILE_SIZE_MB = MAX_FILE_SIZE_MB
    MISTAKE_THRESHOLD_CP = MISTAKE_THRESHOLD_CP
    TOP_MOVE_THRESHOLD_CP = TOP_MOVE_THRESHOLD_CP
    MIN_PAIR_OCCURRENCES = MIN_PAIR_OCCURRENCES
    MATE_SCORE_CP = MATE_SCORE_CP
    PASSWORD_MIN_LENGTH = PASSWORD_MIN_LENGTH
