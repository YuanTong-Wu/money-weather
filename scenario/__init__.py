"""推演模式 (DESIGN §9). Modules use flat imports (`import weather`), so put this folder on sys.path."""
import os as _os
import sys as _sys

_here = _os.path.dirname(_os.path.abspath(__file__))
if _here not in _sys.path:
    _sys.path.insert(0, _here)
