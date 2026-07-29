#import <AppKit/AppKit.h>
#import <CoreGraphics/CoreGraphics.h>

#include <stdio.h>
#include <sysexits.h>

static NSString *CanonicalPath(NSURL *url) {
  NSString *path = url.path;
  if (path == nil || !path.isAbsolutePath) return @"";
  return [[path stringByStandardizingPath] stringByResolvingSymlinksInPath];
}

int main(int argc, const char *argv[]) {
  @autoreleasepool {
    if (argc != 3) return EX_USAGE;

    NSString *bridgeBundleIdentifier = [NSString stringWithUTF8String:argv[1]];
    NSString *obsidianBundleIdentifier = [NSString stringWithUTF8String:argv[2]];
    if (bridgeBundleIdentifier.length == 0 ||
        obsidianBundleIdentifier.length == 0 ||
        [bridgeBundleIdentifier isEqualToString:obsidianBundleIdentifier]) {
      return EX_USAGE;
    }
    CFDictionaryRef sessionRef = CGSessionCopyCurrentDictionary();
    if (sessionRef == NULL) {
      fputs("Unable to inspect the current macOS GUI session\n", stderr);
      return EX_UNAVAILABLE;
    }
    NSDictionary *session = CFBridgingRelease(sessionRef);
    id lockedValue = session[@"CGSSessionScreenIsLocked"];
    if (![lockedValue isKindOfClass:[NSNumber class]]) {
      fputs("macOS GUI session did not report its lock state\n", stderr);
      return EX_UNAVAILABLE;
    }

    NSMutableArray<NSDictionary *> *applications = [NSMutableArray array];
    for (NSRunningApplication *application in
         NSWorkspace.sharedWorkspace.runningApplications) {
      if (application.isTerminated) continue;
      NSString *bundleIdentifier = application.bundleIdentifier;
      if (![bundleIdentifier isEqualToString:bridgeBundleIdentifier] &&
          ![bundleIdentifier isEqualToString:obsidianBundleIdentifier]) {
        continue;
      }
      [applications addObject:@{
        @"pid" : @(application.processIdentifier),
        @"bundleIdentifier" : bundleIdentifier,
        @"bundlePath" : CanonicalPath(application.bundleURL),
        @"executablePath" : CanonicalPath(application.executableURL),
      }];
    }
    [applications sortUsingDescriptors:@[
      [NSSortDescriptor sortDescriptorWithKey:@"bundleIdentifier" ascending:YES],
      [NSSortDescriptor sortDescriptorWithKey:@"bundlePath" ascending:YES],
      [NSSortDescriptor sortDescriptorWithKey:@"pid" ascending:YES],
    ]];

    NSDictionary *snapshot = @{
      @"screenLocked" : @([lockedValue boolValue]),
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
