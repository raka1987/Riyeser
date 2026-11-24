"""Every test starts outside Riyeser Central's demo mode, whatever demo.json this computer has."""
import pytest


@pytest.fixture(autouse=True)
def _no_demo_mode(tmp_path, monkeypatch):
    monkeypatch.setenv("RIYESER_DEMO_FILE", str(tmp_path / "no-demo.json"))
