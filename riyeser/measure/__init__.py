"""Riyeser Measure (Measure & Quote): measure a job by hand, on a plan or photo, on the map, or from a room scan,
then turn the measurements into quote lines with a trade template.

  units.py      metric and imperial: conversions, parsing what people type ("12' 6\"", "3.2 m"), showing amounts
  geometry.py   areas, lengths, rooms, roof pitch, fence posts, polygons with holes, map (lat/lng) geometry
  engine.py     a trade template + a takeoff's quantities -> quote lines (waste, pack rounding, minimum charge)
  seeds.py      the trade templates Riyeser ships (editable assumptions, no prices: every business sets its own rates)
  store.py      the tables (added to any company file, safe to run again)
  quote.py      make or update the Riyeser quote from a takeoff (re-measure updates the measured lines only)
  drawing.py    the measurement summary page on the quote PDF (only the user's own lines: never map imagery)
  floorplan.py  the automatic 2D floor plan of the rooms (SVG on screen, vector lines on the quote PDF)
  scan/         Import a scan: RoomPlan USDZ/JSON, GLB/glTF/OBJ/DAE/STL meshes, DXF plans, CSV room lists -> rooms
  demo.py       sample takeoffs for the demo company
  licence.py    the "measure" licence module: 90 days free from first use, then read-only until it's on the plan

Everything is stored in SI (metres, square metres, cubic metres); the screens show the company's units.
"""
