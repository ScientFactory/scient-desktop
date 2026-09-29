#import <Foundation/Foundation.h>
#import <QuickLookUI/QuickLookUI.h>
#import <objc/runtime.h>

static NSString *principalClassName(NSBundle *bundle) {
    NSDictionary *extension = bundle.infoDictionary[@"NSExtension"];
    return extension[@"NSExtensionPrincipalClass"];
}

int main(int argc, const char *argv[]) {
    @autoreleasepool {
        if (argc != 3) {
            fprintf(stderr, "Usage: class-resolution-smoke production.appex loadable.appex\n");
            return 2;
        }

        NSBundle *production = [NSBundle bundleWithPath:@(argv[1])];
        NSBundle *loadable = [NSBundle bundleWithPath:@(argv[2])];
        NSString *principalName = principalClassName(production);
        if (principalName.length == 0 || ![principalName isEqualToString:principalClassName(loadable)]) {
            fprintf(stderr, "Quick Look principal class missing or differs between bundles\n");
            return 1;
        }

        NSError *error = nil;
        if (![loadable loadAndReturnError:&error]) {
            fprintf(stderr, "Cannot load Quick Look smoke bundle: %s\n", error.localizedDescription.UTF8String);
            return 1;
        }

        Class principal = NSClassFromString(principalName);
        if (!principal || ![principal isSubclassOfClass:QLPreviewProvider.class] ||
            ![principal conformsToProtocol:@protocol(QLPreviewingController)]) {
            fprintf(stderr, "Quick Look principal class does not resolve to a preview provider: %s\n",
                    principalName.UTF8String);
            return 1;
        }

        const char *image = class_getImageName(principal);
        NSString *expectedImage = loadable.executablePath.stringByResolvingSymlinksInPath;
        NSString *actualImage = image ? [@(image) stringByResolvingSymlinksInPath] : nil;
        if (![actualImage isEqualToString:expectedImage]) {
            fprintf(stderr, "Resolved preview provider does not belong to the smoke bundle\n");
            return 1;
        }

        printf("Quick Look principal class resolved: %s\n", principalName.UTF8String);
        return 0;
    }
}
