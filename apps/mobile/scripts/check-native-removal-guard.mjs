import * as NodeChildProcess from "node:child_process";
import * as NodeModule from "node:module";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

// Runs the installed dependency's actual resolver/pop decision, not a JS copy.
// Foundation doubles model containment only; this is not a UIKit interaction test.
const require = NodeModule.createRequire(import.meta.url);
const source = NodeFS.readFileSync(
  process.argv[2] ??
    require.resolve("react-native-screens/ios/helpers/stack/RNSStackNavigationController.mm"),
  "utf8",
);
const start = source.indexOf("- (RNSStackScreenComponentView *)preventedScreenInController:");
const end = source.indexOf("- (void)prepareToolbarForController:", start);
if (start < 0 || end < 0) throw new Error("Native removal guard methods were not found.");
const directory = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "scient-native-removal-"));
try {
  const fixture = NodePath.join(directory, "guard.m");
  const binary = NodePath.join(directory, "guard");
  NodeFS.writeFileSync(
    fixture,
    `#import <Foundation/Foundation.h>
#include <assert.h>
@interface UIViewController : NSObject
@property(nonatomic, strong) NSObject *view;
@end
@implementation UIViewController
@end
@protocol RNSContainer <NSObject>
@end
@protocol RNSContainerItem
- (id<RNSContainer>)resolveNestedContainer;
@end
@interface UINavigationController : UIViewController <RNSContainer>
@property(nonatomic, copy) NSArray<UIViewController *> *viewControllers;
@property(nonatomic, readonly) UIViewController *topViewController;
@end
@implementation UINavigationController
- (UIViewController *)topViewController { return self.viewControllers.lastObject; }
@end
enum { RNSStackScreenActivityModeAttached = 1 };
@interface Emitter : NSObject
@property(nonatomic) NSUInteger prevented;
- (void)emitOnNativeDismissPrevented;
@end
@implementation Emitter
- (void)emitOnNativeDismissPrevented { self.prevented++; }
@end
@interface RNSStackScreenComponentView : NSObject
@property(nonatomic) NSInteger activityMode;
@property(nonatomic) BOOL preventNativeDismiss;
@property(nonatomic, strong) Emitter *reactEventEmitter;
@end
@implementation RNSStackScreenComponentView
@end
@interface SplitScreenController : UIViewController <RNSContainerItem>
@property(nonatomic, strong) id<RNSContainer> nested;
@end
@implementation SplitScreenController
- (id<RNSContainer>)resolveNestedContainer { return self.nested; }
@end
@interface RNSStackNavigationController : UINavigationController {
@public BOOL _performingReactUpdate;
}
- (BOOL)shouldPreventNativePopToController:(UIViewController *)controller;
@end
@implementation RNSStackNavigationController
${source.slice(start, end)}
@end
int main(void) {
  @autoreleasepool {
    RNSStackNavigationController *primary = [RNSStackNavigationController new];
    UIViewController *home = [UIViewController new];
    UIViewController *thread = [UIViewController new];
    RNSStackScreenComponentView *guard = [RNSStackScreenComponentView new];
    guard.activityMode = RNSStackScreenActivityModeAttached;
    guard.preventNativeDismiss = YES;
    guard.reactEventEmitter = [Emitter new];
    thread.view = guard;
    primary.viewControllers = @[home, thread];
    assert([primary shouldPreventNativePopToController:home]);
    RNSStackNavigationController *inner = [RNSStackNavigationController new];
    inner.viewControllers = @[thread];
    SplitScreenController *split = [SplitScreenController new];
    split.nested = inner;
    primary.viewControllers = @[home, split];
    assert([primary shouldPreventNativePopToController:home]);
    RNSStackNavigationController *secondary = [RNSStackNavigationController new];
    secondary.viewControllers = @[split];
    primary.viewControllers = @[home, secondary];
    assert([primary shouldPreventNativePopToController:home] && "collapsed detail-root Back must reach the nested guard");
    assert(guard.reactEventEmitter.prevented == 3);
    guard.preventNativeDismiss = NO;
    assert(![primary shouldPreventNativePopToController:home]);
    guard.preventNativeDismiss = YES;
    guard.activityMode = 0;
    assert(![primary shouldPreventNativePopToController:home]);
    guard.activityMode = RNSStackScreenActivityModeAttached;
    primary->_performingReactUpdate = YES;
    assert(![primary shouldPreventNativePopToController:home]);
    primary->_performingReactUpdate = NO;
    secondary.viewControllers = @[];
    assert(![primary shouldPreventNativePopToController:home]);
    secondary.viewControllers = @[thread, [UIViewController new]];
    assert(![primary shouldPreventNativePopToController:home]);
    assert(guard.reactEventEmitter.prevented == 3);
    puts("Native guard algorithm: 8 cases passed (Foundation containment doubles; no UIKit).");
  }
}
`,
  );
  NodeChildProcess.execFileSync(
    "xcrun",
    ["clang", "-fobjc-arc", "-Wall", "-Werror", "-framework", "Foundation", fixture, "-o", binary],
    { stdio: "inherit" },
  );
  NodeChildProcess.execFileSync(binary, [], { stdio: "inherit" });
} finally {
  NodeFS.rmSync(directory, { recursive: true, force: true });
}
