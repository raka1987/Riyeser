"""Installer links point at the public downloads repository (docs/GOING-PRIVATE.md), not the code repository."""
from riyeser import edition


def test_download_links_use_the_public_downloads_repository():
    assert edition.DOWNLOADS_REPO == "raka1987/riyeser-downloads"
    for ed, name in edition.SETUP_FILES.items():
        assert edition.download_url(ed) == f"https://github.com/raka1987/riyeser-downloads/releases/latest/download/{name}"
