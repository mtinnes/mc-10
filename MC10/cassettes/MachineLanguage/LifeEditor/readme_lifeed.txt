Life-ed
by James Tamer

This is an implementation of John Conway's LIFE.  You can google for
John Conway Life
if you are not familiar with the concept or the rules.

To use the program,
CLOADM
EXEC

The program runs in two modes, EDIT and GENERATE.  It starts out in GENERATE mode running a simple stock pattern.

If you're using the VMC-10 emulator, you should set the keyboard configuration to "Use emulated keys" (or "Use emulated keyboard" which is the same thing).

In GENERATE mode, these keys are active:
Shift E to change to Edit mode.  The screen colors will change to let you know.
BREAK to quit the program and return to BASIC.


In EDIT mode, these keys are active:
W move cursor up
A move cursor left
S move cursor right
Z move cursor down
SPACE BAR toggles the state of the cell under the cursor
Shift G returns to GENERATE mode.  The screen changes color to let you know.
Shift L will load a saved file.  See notes below.
Shift S will save the current screen to cassette.  See notes below.
Shift 1 will change to low-resolution.
Shift 2 will change to high-resolution.
Shift C clears the screen.
BREAK to quit the program and return to BASIC.


Notes:
Saving:  If you're using a real MC-10, follow the screen prompts.
The file saved is always named "LIFEDATA.C10" so you'll need to write a note about what life patterns are saved where on your tape.
If you're using the VMC-10 emulator, a screen will come up that says:
= press record and play then press the space bar =
When you see that, press the space bar.  This will bring up the usual Windows file requester.  You can name the file something more meaningful than the default "LIFEDATA.C10"

Loading:  If you're using a real MC-10, follow the screen prompts.
If you're using the VMC-10 emulator, a screen will come up that says:
= press play then press the the space bar =
When you see that, press the space bar.  Then, from the file menu, select 
Play Cassette File...
and in the file requester, choose a .C10 file.
If the file you choose isn't a Life-ed data file, you'll get a warning...
Then Life-ed will load it anyway.
If it's too big to fit in memory, Life-ed will crash (known bug).
--> You'll be happiest if you attempt to load only valid Life-ed data files.
Valid life-ed files are included:
Oscillators
Glidergun
Rpentomino

Source:
See the ML directory of the VMC10 emulator archive.

