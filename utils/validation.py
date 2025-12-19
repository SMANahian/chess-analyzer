"""Input validation utilities."""
from __future__ import annotations

import re

from config import USERNAME_RE, PASSWORD_MIN_LENGTH


def validate_username(username: str) -> str | None:
    """
    Validate and sanitize a username.
    
    Returns the trimmed username if valid, None otherwise.
    """
    username = username.strip()
    if not USERNAME_RE.fullmatch(username):
        return None
    return username


def validate_password(password: str) -> tuple[bool, str]:
    """
    Validate password strength.
    
    Returns (is_valid, error_message).
    """
    if len(password) < PASSWORD_MIN_LENGTH:
        return False, f"Password must be at least {PASSWORD_MIN_LENGTH} characters long."
    
    if not any(c.isupper() for c in password):
        return False, "Password must contain at least one uppercase letter."
    
    if not any(c.islower() for c in password):
        return False, "Password must contain at least one lowercase letter."
    
    if not any(c.isdigit() for c in password):
        return False, "Password must contain at least one number."
    
    return True, ""


def validate_email(email: str) -> tuple[bool, str]:
    """
    Validate email format.
    
    Returns (is_valid, error_message).
    """
    email = email.strip()
    
    if not email:
        return False, "Email is required."
    
    # Basic email pattern
    email_pattern = re.compile(r"^[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}$")
    
    if not email_pattern.match(email):
        return False, "Please enter a valid email address."
    
    return True, ""
