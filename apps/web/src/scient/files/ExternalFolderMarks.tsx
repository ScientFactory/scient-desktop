// SCIENT-OWNED: the marks of the services a project folder can connect to.
// Third-party marks keep their exact colors.
import { useId } from "react";

import type { Icon } from "~/components/Icons";

/** Overleaf's leaf, drawn by Simple Icons (CC0), in the green of Overleaf's own logo. */
export const OverleafMark: Icon = (props) => (
  <svg viewBox="0 0 24 24" fill="#138A07" {...props}>
    <path d="M22.3515.7484C19.1109-.5101 7.365-.982 7.3452 6.0266c-3.4272 2.194-5.6967 5.768-5.6967 9.598a8.373 8.373 0 0 0 13.1225 6.898 8.373 8.373 0 0 0-1.7668-14.7194c-.6062-.2339-1.9234-.6481-2.9753-.559-1.5007.9544-3.3308 2.9155-4.1949 4.8693 2.5894-3.082 7.5046-2.425 9.1937 1.2287 1.6892 3.6538-.9944 7.8237-5.0198 7.7998a5.4995 5.4995 0 0 1-4.1949-1.9328c-1.485-1.7483-1.8678-3.6444-1.5615-5.4975 1.057-6.4947 8.759-10.1894 14.486-11.6094-1.8677.989-5.2373 2.6134-7.5948 4.3837C18.015 9.1382 19.1308 3.345 22.3515.7484z" />
  </svg>
);

// The marks below come from Gil Barbara's SVG Logos (CC0).

/** Google Drive's triangle. Its gradients need ids unique on the page. */
export const GoogleDriveMark: Icon = (props) => {
  const id = useId();
  return (
    <svg viewBox="0 0 256 238" {...props}>
      <defs>
        <linearGradient id={`${id}-yellow`} x1="86.924%" x2="7.63%" y1="94.294%" y2="45.952%">
          <stop offset="9%" stopColor="#ffe921" />
          <stop offset="100%" stopColor="#fec700" />
        </linearGradient>
        <linearGradient id={`${id}-blue`} x1="99.538%" x2="23.437%" y1="93.901%" y2="54.033%">
          <stop offset="15%" stopColor="#a9a8ff" />
          <stop offset="33%" stopColor="#6d97ff" />
          <stop offset="48%" stopColor="#3186ff" />
        </linearGradient>
        <linearGradient id={`${id}-green`} x1="87.128%" x2="-.639%" y1="51.518%" y2="93.078%">
          <stop offset="55%" stopColor="#0ebc5f" />
          <stop offset="85%" stopColor="#78c9ff" />
        </linearGradient>
        <mask id={`${id}-shape`} fill="#fff">
          <path d="M77.303 29.27c22.531-39.026 78.863-39.027 101.394 0l69.373 120.158c22.531 39.027-5.633 87.81-50.698 87.81H58.628c-45.065 0-73.23-48.783-50.698-87.81z" />
        </mask>
      </defs>
      <g mask={`url(#${id}-shape)`}>
        <path
          transform="translate(-42.87 -58.67)"
          fill={`url(#${id}-yellow)`}
          d="M341.719 295.937H200.166l-29.293-50.735l70.777-122.589z"
        />
        <path
          transform="translate(-42.87 -58.67)"
          fill={`url(#${id}-blue)`}
          d="m0 295.916l100.069-173.325v.003l-29.282 50.723h58.57l70.783 122.596l-200.138.001z"
        />
        <path
          transform="translate(-42.87 -58.67)"
          fill={`url(#${id}-green)`}
          d="m170.881 0l70.781 122.6l-29.286 50.726H70.812z"
        />
      </g>
    </svg>
  );
};

/** Microsoft OneDrive's cloud. */
export const OneDriveMark: Icon = (props) => (
  <svg viewBox="0 0 256 165" {...props}>
    <path
      fill="#0364b8"
      d="m154.66 110.682l52.842-50.534c-10.976-42.8-54.57-68.597-97.37-57.62a80 80 0 0 0-46.952 33.51c.817-.02 91.48 74.644 91.48 74.644"
    />
    <path
      fill="#0078d4"
      d="m97.618 45.552l-.002.009a63.7 63.7 0 0 0-33.619-9.543c-.274 0-.544.017-.818.02C27.852 36.476-.432 65.47.005 100.798a63.97 63.97 0 0 0 11.493 35.798l79.165-9.915l60.694-48.94z"
    />
    <path
      fill="#1490df"
      d="M207.502 60.148a53 53 0 0 0-3.51-.131a51.8 51.8 0 0 0-20.61 4.254l-.002-.005l-32.022 13.475l35.302 43.607l63.11 15.341c13.62-25.283 4.164-56.82-21.12-70.44a52 52 0 0 0-21.148-6.1"
    />
    <path
      fill="#28a8ea"
      d="M11.498 136.596a63.91 63.91 0 0 0 52.5 27.417h139.994a51.99 51.99 0 0 0 45.778-27.323l-98.413-58.95z"
    />
  </svg>
);

/** Dropbox's open box. */
export const DropboxMark: Icon = (props) => (
  <svg viewBox="0 0 256 218" fill="#0061ff" {...props}>
    <path d="M63.995 0L0 40.771l63.995 40.772L128 40.771zM192 0l-64 40.775l64 40.775l64.001-40.775zM0 122.321l63.995 40.772L128 122.321L63.995 81.55zM192 81.55l-64 40.775l64 40.774l64-40.774zM64 176.771l64.005 40.772L192 176.771L128.005 136z" />
  </svg>
);
