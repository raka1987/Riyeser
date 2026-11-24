"""Every test starts outside Riyeser Central's demo mode, whatever demo.json this computer has, and with its own empty
Riyeser folders, so no test reads or writes this computer's licence, company profile or licence markers."""
import pytest


@pytest.fixture(autouse=True)
def _no_demo_mode(tmp_path, monkeypatch):
    monkeypatch.setenv("RIYESER_DEMO_FILE", str(tmp_path / "no-demo.json"))


@pytest.fixture(autouse=True)
def _own_riyeser_folders(tmp_path, monkeypatch):
    monkeypatch.setenv("APPDATA", str(tmp_path / "_appdata"))
    monkeypatch.setenv("RIYESER_HOME", str(tmp_path / "_riyeser_home"))
