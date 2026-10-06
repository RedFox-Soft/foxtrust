"""Records one Camoufox sample for the bot-verdict labelled set (spec 007 research R8).

Development only. Start `foxtrust bot record --label camoufox --kind automation` first, then:

    pip install -U camoufox && python -m camoufox fetch
    python camoufox_record.py [url]
"""

import sys

from camoufox.sync_api import Camoufox

hold = "--hold" in sys.argv
args = [a for a in sys.argv[1:] if a != "--hold"]
url = args[0] if args else "http://127.0.0.1:8795/"

# --hold: Camoufox's own human-like cursor moves to the hold button and holds it (spec 009 baseline).
with Camoufox(headless=True, humanize=hold) as browser:
    page = browser.new_page()
    page.goto(url)
    if hold:
        button = page.wait_for_selector("#foxtrust-hold:not([disabled])", timeout=30_000)
        box = button.bounding_box()
        page.mouse.move(box["x"] + box["width"] / 2, box["y"] + box["height"] / 2)
        page.mouse.down()
        page.wait_for_timeout(1000)
        page.mouse.up()
    page.wait_for_function("document.body.innerText.includes('Recorded')", timeout=30_000)
print("camoufox: recorded")
