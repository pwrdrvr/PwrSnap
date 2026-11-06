# Crossfades shortened the picture and truncated narration

A real-codec regression test reproduced three one-second narration takes
exporting as a **2.2-second movie** when the two visual boundaries used
0.4-second crossfades. The picture lost 0.8 seconds; audio stayed three seconds;
`-shortest` discarded the last 0.8 seconds of narration.

The composer now gives each incoming picture enough transition overlap to
preserve the audio axis. Its audio duration is recorded before extending the
picture. Sequence beats already have these visual handles, so they are not
extended twice. Narration remains concatenated without audio fades or overlaps.
A transition can start showing the incoming picture before the previous line
ends; it cannot shorten the previous line or the reel's spoken tail.

The oracle in `composer.test.ts` checks both independent takes and a continuous
sequence. It decodes the exported PCM and verifies non-silent audio near the
three-second ending, as well as container duration. A duration-only check with
silent fixtures would not prove that the last spoken samples survived.

This bug is separate from the layered launch template's design. That template
initially used nine fixed narration slots, while Sizzle's primary sequence model
has one narration and phrase-anchored visual beats. The launch template now
accepts a whole-reel script or recording and defaults image zoom off. Its visual
slots are still fixed; automatic word-anchor integration is not implemented in
that template. Supporting one voice track must not be described as completing
that integration.
