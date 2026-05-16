"""Shared pytest configuration for the catcam Python test suite.

The detection code imports `ultralytics` and `cv2` at module load time. Both
pull in large native/ML dependencies that a unit test should never need. When
they are not installed we register minimal stand-in modules so the code under
test still imports; individual tests then patch the specific symbol they
exercise (`YOLO`, `YOLOWorld`, ...) with a purpose-built fake.
"""

import sys
import types


def _stub_module(name: str, **attributes: object) -> None:
    """Register a placeholder module unless the real package is importable."""
    try:
        __import__(name)
        return
    except ImportError:
        pass
    module = types.ModuleType(name)
    module.__catcam_stub__ = True  # type: ignore[attr-defined]
    for attr, value in attributes.items():
        setattr(module, attr, value)
    sys.modules[name] = module


class _UnpatchedModel:
    """Stand-in for a YOLO model class — fails loudly if a test forgets to patch it."""

    def __init__(self, *args: object, **kwargs: object) -> None:
        raise RuntimeError(
            "ultralytics is stubbed in tests. Patch the YOLO/YOLOWorld symbol in "
            "the module under test with a fake model instead of loading a real one."
        )


_stub_module("ultralytics", YOLO=_UnpatchedModel, YOLOWorld=_UnpatchedModel)
_stub_module("cv2")
