#!/bin/sh
# Gate sweep for shore-staircase. Scratch, not part of the build.
for mr in 3 4 5 6 8 10; do
  for ma in 1.0 1.5 2.0 2.5 3.0; do
    n=$(node server/dist/tools/mapAudit.js --only=shore-staircase --minrun="$mr" --minexcess="$ma" --summary | grep 'shore-staircase' | awk '{print $3}')
    echo "minrun=$mr minexcess=$ma -> $n"
  done
done
