# Wurm Online Advanced Shard Analyzer (Static)

A hostable tool to combine Analyse/Prospecting constraint text and narrow down likely vein tiles.

## How to use
1. Paste Analyse/Prospecting output into the textbox.
2. Enter how many tiles you stepped from the original paste:
   - East = +x, West = −x
   - North = +y, South = −y
3. Click **Add step + log**.
4. Repeat for additional steps/logs.
5. Use **Layer** to inspect a specific vein key; use **Download PNG** to save the map.

## Locking behavior
If a vein resolves to exactly one tile, it locks to that world coordinate and will not “move” when you add later steps.
