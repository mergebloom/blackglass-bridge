#import <AppKit/AppKit.h>
#import <CoreGraphics/CoreGraphics.h>

#include <stdio.h>
#include <stdlib.h>
#include <libproc.h>
#include <sysexits.h>
#include <unistd.h>

static NSString *CanonicalPath(NSURL *url) {
  NSString *path = url.path;
  if (path == nil || !path.isAbsolutePath) return @"";
  return [[path stringByStandardizingPath] stringByResolvingSymlinksInPath];
}

int main(int argc, const char *argv[]) {
  @autoreleasepool {
    if (argc != 3) return EX_USAGE;

    NSString *blackglassBundleIdentifier = [NSString stringWithUTF8String:argv[1]];
    NSString *obsidianBundleIdentifier = [NSString stringWithUTF8String:argv[2]];
    if (blackglassBundleIdentifier.length == 0 ||
        obsidianBundleIdentifier.length == 0 ||
        [blackglassBundleIdentifier isEqualToString:obsidianBundleIdentifier]) {
      return EX_USAGE;
    }
    CFDictionaryRef sessionRef = CGSessionCopyCurrentDictionary();
    if (sessionRef == NULL) {
      fputs("Unable to inspect the current macOS GUI session\n", stderr);
      return EX_UNAVAILABLE;
    }
    NSDictionary *session = CFBridgingRelease(sessionRef);
    id lockedValue = session[@"CGSSessionScreenIsLocked"];
    BOOL screenLocked = NO;
    if (lockedValue != nil) {
      if (![lockedValue isKindOfClass:[NSNumber class]]) {
        fputs("macOS GUI session reported a malformed lock state\n", stderr);
        return EX_UNAVAILABLE;
      }
      screenLocked = [lockedValue boolValue];
    } else {
      // Recent macOS releases omit CGSSessionScreenIsLocked from an unlocked
      // session instead of returning @NO. Accept that representation only
      // when the remaining session facts positively identify this process's
      // active, fully logged-in console session.
      id onConsoleValue = session[@"kCGSSessionOnConsoleKey"];
      id loginDoneValue = session[@"kCGSessionLoginDoneKey"];
      id userIDValue = session[@"kCGSSessionUserIDKey"];
      if (![onConsoleValue isKindOfClass:[NSNumber class]] ||
          ![loginDoneValue isKindOfClass:[NSNumber class]] ||
          ![userIDValue isKindOfClass:[NSNumber class]] ||
          ![onConsoleValue boolValue] || ![loginDoneValue boolValue] ||
          [userIDValue unsignedIntValue] != getuid()) {
        fputs("macOS GUI session did not prove an active unlocked console\n",
              stderr);
        return EX_UNAVAILABLE;
      }
    }

    NSMutableArray<NSDictionary *> *applications = [NSMutableArray array];
    NSMutableSet<NSNumber *> *applicationPIDs = [NSMutableSet set];
    for (NSRunningApplication *application in
         NSWorkspace.sharedWorkspace.runningApplications) {
      if (application.isTerminated) continue;
      NSString *bundleIdentifier = application.bundleIdentifier;
      if (![bundleIdentifier isEqualToString:blackglassBundleIdentifier] &&
          ![bundleIdentifier isEqualToString:obsidianBundleIdentifier]) {
        continue;
      }
      [applications addObject:@{
        @"pid" : @(application.processIdentifier),
        @"bundleIdentifier" : bundleIdentifier,
        @"bundlePath" : CanonicalPath(application.bundleURL),
        @"executablePath" : CanonicalPath(application.executableURL),
      }];
      [applicationPIDs addObject:@(application.processIdentifier)];
    }

    // LaunchServices can omit generated copies that were started with an
    // isolated profile. Inspect kernel-reported executable paths as a
    // fail-closed fallback so any running generated Blackglass Bridge.app is found.
    int processCount = proc_listallpids(NULL, 0);
    if (processCount <= 0) {
      fputs("Unable to enumerate running macOS processes\n", stderr);
      return EX_UNAVAILABLE;
    }
    pid_t *processes = calloc((size_t)processCount, sizeof(pid_t));
    if (processes == NULL) return EX_OSERR;
    int populatedCount = proc_listallpids(processes,
                                          processCount * (int)sizeof(pid_t));
    if (populatedCount <= 0) {
      free(processes);
      fputs("Unable to read running macOS processes\n", stderr);
      return EX_UNAVAILABLE;
    }
    NSString *generatedMarker = @"/Blackglass Bridge.app/Contents/MacOS/";
    for (int index = 0; index < populatedCount; index++) {
      pid_t pid = processes[index];
      if (pid <= 0 || [applicationPIDs containsObject:@(pid)]) continue;
      char pathBuffer[PROC_PIDPATHINFO_MAXSIZE] = {0};
      if (proc_pidpath(pid, pathBuffer, sizeof(pathBuffer)) <= 0) continue;
      NSString *executablePath = [NSString stringWithUTF8String:pathBuffer];
      NSRange markerRange = [executablePath rangeOfString:generatedMarker];
      if (markerRange.location == NSNotFound) continue;
      NSString *bundlePath = [[executablePath
          substringToIndex:markerRange.location]
          stringByAppendingString:@"/Blackglass Bridge.app"];
      [applications addObject:@{
        @"pid" : @(pid),
        @"bundleIdentifier" : blackglassBundleIdentifier,
        @"bundlePath" : bundlePath,
        @"executablePath" : executablePath,
      }];
      [applicationPIDs addObject:@(pid)];
    }
    free(processes);
    [applications sortUsingDescriptors:@[
      [NSSortDescriptor sortDescriptorWithKey:@"bundleIdentifier" ascending:YES],
      [NSSortDescriptor sortDescriptorWithKey:@"bundlePath" ascending:YES],
      [NSSortDescriptor sortDescriptorWithKey:@"pid" ascending:YES],
    ]];

    NSDictionary *snapshot = @{
      @"screenLocked" : @(screenLocked),
      @"applications" : applications,
    };
    NSError *jsonError = nil;
    NSData *json = [NSJSONSerialization dataWithJSONObject:snapshot
                                                   options:0
                                                     error:&jsonError];
    if (json == nil) {
      fprintf(stderr, "Unable to encode macOS launch preflight: %s\n",
              jsonError.localizedDescription.UTF8String);
      return EX_SOFTWARE;
    }
    fwrite(json.bytes, 1, json.length, stdout);
    fputc('\n', stdout);
    return EX_OK;
  }
}
