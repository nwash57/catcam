# Testing

The repo has four independently testable pieces. Each uses its ecosystem's
standard tooling.

## Python services (`cat_detect`, `auto_label`, `train`)

Framework: **pytest**. Config lives in `pyproject.toml`; tests live in `tests/`,
mirroring the source layout (`tests/cat_detect/`, `tests/auto_label/`,
`tests/train/`).

```bash
python -m venv .venv && source .venv/bin/activate
pip install -r requirements-dev.txt
pytest
```

`ultralytics` and `cv2` are heavy ML/native dependencies. `tests/conftest.py`
registers lightweight stub modules for them when they are not installed, so
unit tests import and run without a GPU, a camera, or the real model weights.
Tests patch the specific symbol they exercise (`YOLO`, `YOLOWorld`) with a
purpose-built fake — see `tests/cat_detect/test_detector.py` for the pattern.

## Backend API (`backend/CatCam.Api`)

Framework: **xUnit**. The test project is `backend/CatCam.Api.Tests` and is
registered in `backend/backend.slnx`.

```bash
cd backend
dotnet test
```

`CatCamApiFactory` boots the API in-memory with `WebApplicationFactory<Program>`,
pointed at a throwaway temp captures directory. The ffmpeg-driven
`TranscodeService` is removed in tests to keep them hermetic.

## Frontend (`frontend`)

Framework: **Vitest** (via Angular's `@angular/build:unit-test` builder), with
specs as `*.spec.ts` next to their source.

```bash
cd frontend
pnpm test     # or: pnpm ng test
```

This was already configured before the test infrastructure work.

## Multi-agent workflow

`.claude/agents/` defines `developer`, `adversary`, and `test-writer` subagents.
The `test-writer` agent follows the conventions documented here.
