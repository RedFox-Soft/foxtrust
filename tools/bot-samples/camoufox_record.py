"""Records one Camoufox sample for the bot-verdict labelled set (spec 007 research R8).

Development only. Start `foxtrust bot record --label camoufox --kind automation` first, then:

    pip install -U camoufox && python -m camoufox fetch
    python camoufox_record.py [url]
"""

import sys

from camoufox.sync_api import Camoufox

url = sys.argv[1] if len(sys.argv) > 1 else "http://127.0.0.1:8795/"

with Camoufox(headless=True) as browser:
    page = browser.new_page()
    page.goto(url)
    page.wait_for_function("document.body.innerText.includes('Recorded')", timeout=30_000)
print("camoufox: recorded")
