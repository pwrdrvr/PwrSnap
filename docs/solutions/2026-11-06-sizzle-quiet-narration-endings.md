# Silence trimming must retain quiet narration endings

The delivered PwrDisk timeline reel used nine supplied/generated voice takes.
Its pictures and mixed audio were independent, so visual scene boundaries did
not trim its audio. Comparing supplied WAVs to prepared tracks nevertheless
showed approximately 70–190 ms removed from their ends. Repeating threshold
trimming on already tight takes can discard quiet consonants and breath tails.
This measured loss does not establish the full half-second cutoff reported by
the operator.

The trimmer now retains a 150 ms margin at each end, and bypasses the tempo
filter when the playback rate is one. Audio cache version 4 invalidates the
previously prepared takes. Continuous narration defaults to no silence trim.

The nonheaded waveform oracle in `timeline-render.test.ts` supplies a loud
syllable followed by a 100 ms quiet tone below the silence threshold. It checks
that the prepared PCM retains the quiet ending. Before the fix the ending was
absent (0 ms); after the fix more than 90 ms remains. Transcription alone is not
an oracle for this: an ASR model can infer a complete word from a clipped sound.
