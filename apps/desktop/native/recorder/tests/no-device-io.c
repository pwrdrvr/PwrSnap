// Test-only dyld interposition. Synthetic AAC verification must never create
// hardware IO, even when the operator has already granted microphone access.
#include <CoreAudio/CoreAudio.h>
#include <unistd.h>

#ifdef PWRSNAP_DEVICE_IO_GUARD_PROBE
int main(int argc, char **argv) {
    (void)argv;
    AudioDeviceIOProcID proc = NULL;
    // An invalid device cannot open hardware if the guard fails to load.
    if (argc > 1) {
        AudioDeviceCreateIOProcIDWithBlock(&proc, kAudioObjectUnknown, NULL,
            ^(const AudioTimeStamp *now, const AudioBufferList *input,
              const AudioTimeStamp *inputTime, AudioBufferList *output,
              const AudioTimeStamp *outputTime) {
                (void)now; (void)input; (void)inputTime; (void)output; (void)outputTime;
            });
    } else {
        AudioDeviceCreateIOProcID(kAudioObjectUnknown, NULL, NULL, &proc);
    }
    return 0;
}
#else
static _Noreturn void rejectDeviceIO(void) {
    const char message[] = "roundtrip: forbidden CoreAudio device IO initialization\n";
    write(STDERR_FILENO, message, sizeof(message) - 1);
    _exit(97);
}

static OSStatus denyDeviceIO(AudioObjectID device, AudioDeviceIOProc proc,
                             void *clientData, AudioDeviceIOProcID *procID) {
    (void)device; (void)proc; (void)clientData; (void)procID;
    rejectDeviceIO();
}

static OSStatus denyDeviceIOWithBlock(AudioDeviceIOProcID *procID,
                                      AudioObjectID device, dispatch_queue_t queue,
                                      AudioDeviceIOBlock block) {
    (void)procID; (void)device; (void)queue; (void)block;
    rejectDeviceIO();
}

__attribute__((constructor))
static void guardLoaded(void) {
    const char message[] = "roundtrip: device IO guard active\n";
    write(STDERR_FILENO, message, sizeof(message) - 1);
}

__attribute__((used, section("__DATA,__interpose")))
static const struct { const void *replacement; const void *original; } deviceIOGuards[] = {
    { (const void *)denyDeviceIO, (const void *)AudioDeviceCreateIOProcID },
    { (const void *)denyDeviceIOWithBlock, (const void *)AudioDeviceCreateIOProcIDWithBlock }
};
#endif
