#import <Foundation/Foundation.h>

// Match the Objective-C option-set bridge while keeping notification fixtures
// independent of the simulator and the host's notification service.
typedef NS_OPTIONS(NSUInteger, UNNotificationPresentationOptions) {
  UNNotificationPresentationOptionNone = 0,
};
