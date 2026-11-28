"""In-app "Download" buttons go through riyeser.com (the download hand-off page / counter), never a github.com URL,
so the app doesn't reveal where the code lives. Releases themselves still come from the public downloads repository
(docs/GOING-PRIVATE.md); that redirect is handled by riyeser.com, not shown in the app."""
from riyeser import edition


def test_download_links_go_through_riyeser_com():
    assert edition.DOWNLOADS_REPO == "raka1987/riyeser-downloads"
    for ed in edition.SETUP_FILES:
        url = edition.download_url(ed)
        assert url == f"https://riyeser.com/download/{edition.DOWNLOAD_PAGE[ed]}.html"
        assert "github.com" not in url
