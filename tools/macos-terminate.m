#import <AppKit/AppKit.h>

#include <errno.h>
#include <limits.h>
#include <stdio.h>
#include <stdlib.h>
#include <sysexits.h>

static NSString *CanonicalPath(const char *value) {
  NSString *path = [NSString stringWithUTF8String:value];
  if (path == nil || ![path isAbsolutePath]) return nil;
  return [[path stringByStandardizingPath] stringByResolvingSymlinksInPath];
}

int main(int argc, const char *argv[]) {
  @autoreleasepool {
    if (argc != 3) return EX_USAGE;

    errno = 0;
    char *end = NULL;
    long rawPid = strtol(argv[1], &end, 10);
    if (errno != 0 || end == argv[1] || *end != '\0' || rawPid < 1 ||
        rawPid > INT_MAX) {
      return EX_USAGE;
    }

    NSString *expectedBundle = CanonicalPath(argv[2]);
    if (expectedBundle == nil || ![expectedBundle hasSuffix:@".app"]) {
      return EX_USAGE;
    }
    NSString *expectedExecutable =
        [expectedBundle stringByAppendingPathComponent:@"Contents/MacOS/Obsidian"];

    NSRunningApplication *application =
        [NSRunningApplication runningApplicationWithProcessIdentifier:(pid_t)rawPid];
    if (application == nil || application.isTerminated) return EX_UNAVAILABLE;

    NSString *actualBundle =
        [[application.bundleURL.path stringByStandardizingPath]
            stringByResolvingSymlinksInPath];
    NSString *actualExecutable =
        [[application.executableURL.path stringByStandardizingPath]
            stringByResolvingSymlinksInPath];
    if (![actualBundle isEqualToString:expectedBundle] ||
        ![actualExecutable isEqualToString:expectedExecutable]) {
      return EX_NOPERM;
    }
    if (![application terminate]) return EX_UNAVAILABLE;

    fputs("termination-requested\n", stdout);
    return EX_OK;
  }
}
