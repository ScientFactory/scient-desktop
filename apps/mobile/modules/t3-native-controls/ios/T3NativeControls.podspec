Pod::Spec.new do |s|
  s.name           = 'T3NativeControls'
  s.version        = '1.0.0'
  s.summary        = 'Native UIKit controls for T3 Code mobile.'
  s.description    = 'UIKit-backed controls that match native iOS navigation chrome.'
  s.author         = 'T3 Tools'
  s.homepage       = 'https://t3tools.com'
  s.platforms      = {
    :ios => '18.0',
  }
  s.source         = { :path => '.' }
  s.static_framework = true

  s.dependency 'ExpoModulesCore'
  xcconfig = {
    'DEFINES_MODULE' => 'YES',
  }
  # Swift 6.4 also ships with SDK 27.0, which has no hinge APIs. Detect the
  # SDK that supplies UIKit instead of treating the compiler as its version.
  sdk_version = Gem::Version.new(Pod::Executable.execute_command('xcrun',
    ['--sdk', 'iphoneos', '--show-sdk-version']).strip)
  if sdk_version >= Gem::Version.new('27.1')
    xcconfig['SWIFT_ACTIVE_COMPILATION_CONDITIONS'] = '$(inherited) T3_HAS_HINGE_SDK'
  end
  s.pod_target_xcconfig = xcconfig
  s.source_files = '**/*.{h,m,mm,swift,hpp,cpp}'
end
