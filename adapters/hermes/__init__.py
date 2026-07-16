"""Hermes adapter and Python persona-engine runtime."""

from .plugin import register
from .runtime import report_adapter_error, set, turn
from .version import VERSION

__all__ = ["register", "report_adapter_error", "set", "turn"]
__version__ = VERSION
