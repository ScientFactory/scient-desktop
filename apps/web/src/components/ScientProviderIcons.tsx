// SCIENT-OWNED: provider marks Scient adds to the inherited icon set. Icons.tsx
// re-exports them so existing imports stay unchanged.
// Third-party marks keep their exact colors, the same exemption Icons.tsx has.
/* oxlint-disable shadcn/no-raw-colors */
import { useId } from "react";
import { cn } from "~/lib/utils";
import scientAgentSymbolUrl from "../assets/scient-agent-symbol.svg?url";
import type { Icon } from "./Icons";

/** Official OpenRouter mark, rendered in the surrounding text color. */
export const OpenRouterIcon: Icon = (props) => (
  <svg {...props} viewBox="0 0 401.4 293.7" fill="currentColor">
    <path d="M303.9475 17.19926c42.79734 0 77.48933 34.69327 77.48933 77.48933s-34.69199 77.48933-77.48933 77.48933l76.86166 76.86244c9.76367 9.76313 2.84903 26.45667-10.95697 26.45667H148.96884c-71.32686 0-129.14889-57.82202-129.14889-129.14889S77.64197 17.19926 148.96884 17.19926H303.9475ZM148.96884 68.85881c-42.79607 0-77.48933 34.69327-77.48933 77.48933s34.69327 77.48933 77.48933 77.48933 77.48933-34.69327 77.48933-77.48933-34.69327-77.48933-77.48933-77.48933Z" />
  </svg>
);

/** Official Factory Droid mark (carried over from the prior Scient app). */
export const DroidIcon: Icon = (props) => (
  <svg {...props} viewBox="0 0 67 65" fill="none" xmlns="http://www.w3.org/2000/svg">
    <path
      fill="currentColor"
      d="M47.75 11.15a.867.867 0 0 1-.671-.806.84.84 0 0 1 .067-.362c1.688-4.007 2.433-7.213 1.23-8.555-3.183-3.56-15.952 3.52-20.024 5.919a.9.9 0 0 1-1.273-.41c-1.711-3.998-3.51-6.78-5.334-6.9-4.833-.323-8.73 13.49-9.87 17.992a.85.85 0 0 1-.459.563.9.9 0 0 1-.737.027c-4.109-1.647-7.398-2.373-8.773-1.2-3.651 3.104 3.609 15.557 6.068 19.528a.85.85 0 0 1-.11 1.031.9.9 0 0 1-.31.21C3.455 39.856.604 41.61.478 43.389c-.329 4.713 13.834 8.513 18.452 9.625q.186.046.337.163a.87.87 0 0 1 .332.642.84.84 0 0 1-.067.362c-1.688 4.007-2.433 7.214-1.23 8.555 3.183 3.561 15.954-3.519 20.025-5.917a.9.9 0 0 1 1.058.107.9.9 0 0 1 .215.302c1.711 3.997 3.509 6.779 5.334 6.9 4.833.322 8.73-13.49 9.868-17.993a.85.85 0 0 1 .168-.33.88.88 0 0 1 .659-.324.9.9 0 0 1 .371.066c4.109 1.647 7.397 2.372 8.773 1.2 3.651-3.105-3.61-15.559-6.07-19.53a.85.85 0 0 1 .111-1.03.9.9 0 0 1 .31-.21c4.1-1.67 6.952-3.424 7.075-5.203.331-4.713-13.833-8.513-18.45-9.623m-5.546-4.518c.93 1.624-3.858 12.446-7.42 20.015a.7.7 0 0 1-.28.303.71.71 0 0 1-.796-.059.7.7 0 0 1-.23-.341c-1.439-4.921-3.082-10.704-4.841-15.612a.84.84 0 0 1 .01-.594.87.87 0 0 1 .401-.446c4.392-2.34 11.908-5.446 13.156-3.266m-21.048 1.34c1.833.507 6.294 11.46 9.264 19.268a.67.67 0 0 1-.2.754.71.71 0 0 1-.794.08c-4.589-2.485-9.94-5.444-14.743-7.702a.87.87 0 0 1-.422-.427.84.84 0 0 1-.04-.591c1.414-4.679 4.471-12.063 6.935-11.383M7.243 23.433c1.664-.906 12.762 3.763 20.522 7.235.13.058.239.154.311.274a.67.67 0 0 1-.06.776.7.7 0 0 1-.35.225c-5.045 1.403-10.976 3.006-16.01 4.721a.9.9 0 0 1-.607-.01.88.88 0 0 1-.456-.391c-2.395-4.284-5.586-11.613-3.35-12.83M8.617 43.96c.519-1.788 11.752-6.14 19.758-9.035a.72.72 0 0 1 .773.195.67.67 0 0 1 .081.774c-2.548 4.475-5.582 9.694-7.898 14.377a.87.87 0 0 1-.437.413.9.9 0 0 1-.607.039c-4.797-1.37-12.37-4.36-11.67-6.763m15.855 13.568c-.93-1.623 3.859-12.446 7.42-20.014a.7.7 0 0 1 .28-.303.715.715 0 0 1 .796.059.7.7 0 0 1 .23.34c1.439 4.92 3.083 10.705 4.841 15.613a.84.84 0 0 1-.01.593.87.87 0 0 1-.402.445c-4.391 2.335-11.908 5.447-13.15 3.267zm21.049-1.34c-1.836-.506-6.297-11.461-9.266-19.269a.67.67 0 0 1 .2-.755.71.71 0 0 1 .795-.078c4.587 2.484 9.94 5.445 14.742 7.703.189.088.339.24.423.426a.84.84 0 0 1 .039.592c-1.413 4.686-4.47 12.063-6.933 11.381m13.912-15.462c-1.665.907-12.762-3.763-20.523-7.236a.7.7 0 0 1-.311-.273.67.67 0 0 1 .06-.777.7.7 0 0 1 .35-.225c5.046-1.402 10.975-3.005 16.009-4.72a.9.9 0 0 1 .609.01.88.88 0 0 1 .457.392c2.393 4.282 5.584 11.613 3.349 12.829M58.06 20.2c-.521 1.79-11.753 6.14-19.759 9.036a.72.72 0 0 1-.774-.195.67.67 0 0 1-.08-.776c2.547-4.474 5.581-9.694 7.897-14.377a.87.87 0 0 1 .437-.412.9.9 0 0 1 .607-.038c4.797 1.377 12.37 4.359 11.672 6.762"
    />
  </svg>
);

// Registry provider marks used by the provider picker.
export const Gemini: Icon = (props) => (
  <svg {...props} viewBox="0 0 296 298" fill="none">
    <mask
      id="gemini__a"
      width="296"
      height="298"
      x="0"
      y="0"
      maskUnits="userSpaceOnUse"
      style={{ maskType: "alpha" }}
    >
      <path
        fill="#3186FF"
        d="M141.201 4.886c2.282-6.17 11.042-6.071 13.184.148l5.985 17.37a184.004 184.004 0 0 0 111.257 113.049l19.304 6.997c6.143 2.227 6.156 10.91.02 13.155l-19.35 7.082a184.001 184.001 0 0 0-109.495 109.385l-7.573 20.629c-2.241 6.105-10.869 6.121-13.133.025l-7.908-21.296a184 184 0 0 0-109.02-108.658l-19.698-7.239c-6.102-2.243-6.118-10.867-.025-13.132l20.083-7.467A183.998 183.998 0 0 0 133.291 26.28l7.91-21.394Z"
      />
    </mask>
    <g mask="url(#gemini__a)">
      <g filter="url(#gemini__b)">
        <ellipse cx="163" cy="149" fill="#3689FF" rx="196" ry="159" />
      </g>
      <g filter="url(#gemini__c)">
        <ellipse cx="33.5" cy="142.5" fill="#F6C013" rx="68.5" ry="72.5" />
      </g>
      <g filter="url(#gemini__d)">
        <ellipse cx="19.5" cy="148.5" fill="#F6C013" rx="68.5" ry="72.5" />
      </g>
      <g filter="url(#gemini__e)">
        <path fill="#FA4340" d="M194 10.5C172 82.5 65.5 134.333 22.5 135L144-66l50 76.5Z" />
      </g>
      <g filter="url(#gemini__f)">
        <path fill="#FA4340" d="M190.5-12.5C168.5 59.5 62 111.333 19 112L140.5-89l50 76.5Z" />
      </g>
      <g filter="url(#gemini__g)">
        <path fill="#14BB69" d="M194.5 279.5C172.5 207.5 66 155.667 23 155l121.5 201 50-76.5Z" />
      </g>
      <g filter="url(#gemini__h)">
        <path fill="#14BB69" d="M196.5 320.5C174.5 248.5 68 196.667 25 196l121.5 201 50-76.5Z" />
      </g>
    </g>
    <defs>
      <filter
        id="gemini__b"
        width="464"
        height="390"
        x="-69"
        y="-46"
        colorInterpolationFilters="sRGB"
        filterUnits="userSpaceOnUse"
      >
        <feFlood floodOpacity="0" result="BackgroundImageFix" />
        <feBlend in="SourceGraphic" in2="BackgroundImageFix" result="shape" />
        <feGaussianBlur result="effect1_foregroundBlur_69_17998" stdDeviation="18" />
      </filter>
      <filter
        id="gemini__c"
        width="265"
        height="273"
        x="-99"
        y="6"
        colorInterpolationFilters="sRGB"
        filterUnits="userSpaceOnUse"
      >
        <feFlood floodOpacity="0" result="BackgroundImageFix" />
        <feBlend in="SourceGraphic" in2="BackgroundImageFix" result="shape" />
        <feGaussianBlur result="effect1_foregroundBlur_69_17998" stdDeviation="32" />
      </filter>
      <filter
        id="gemini__d"
        width="265"
        height="273"
        x="-113"
        y="12"
        colorInterpolationFilters="sRGB"
        filterUnits="userSpaceOnUse"
      >
        <feFlood floodOpacity="0" result="BackgroundImageFix" />
        <feBlend in="SourceGraphic" in2="BackgroundImageFix" result="shape" />
        <feGaussianBlur result="effect1_foregroundBlur_69_17998" stdDeviation="32" />
      </filter>
      <filter
        id="gemini__e"
        width="299.5"
        height="329"
        x="-41.5"
        y="-130"
        colorInterpolationFilters="sRGB"
        filterUnits="userSpaceOnUse"
      >
        <feFlood floodOpacity="0" result="BackgroundImageFix" />
        <feBlend in="SourceGraphic" in2="BackgroundImageFix" result="shape" />
        <feGaussianBlur result="effect1_foregroundBlur_69_17998" stdDeviation="32" />
      </filter>
      <filter
        id="gemini__f"
        width="299.5"
        height="329"
        x="-45"
        y="-153"
        colorInterpolationFilters="sRGB"
        filterUnits="userSpaceOnUse"
      >
        <feFlood floodOpacity="0" result="BackgroundImageFix" />
        <feBlend in="SourceGraphic" in2="BackgroundImageFix" result="shape" />
        <feGaussianBlur result="effect1_foregroundBlur_69_17998" stdDeviation="32" />
      </filter>
      <filter
        id="gemini__g"
        width="299.5"
        height="329"
        x="-41"
        y="91"
        colorInterpolationFilters="sRGB"
        filterUnits="userSpaceOnUse"
      >
        <feFlood floodOpacity="0" result="BackgroundImageFix" />
        <feBlend in="SourceGraphic" in2="BackgroundImageFix" result="shape" />
        <feGaussianBlur result="effect1_foregroundBlur_69_17998" stdDeviation="32" />
      </filter>
      <filter
        id="gemini__h"
        width="299.5"
        height="329"
        x="-39"
        y="132"
        colorInterpolationFilters="sRGB"
        filterUnits="userSpaceOnUse"
      >
        <feFlood floodOpacity="0" result="BackgroundImageFix" />
        <feBlend in="SourceGraphic" in2="BackgroundImageFix" result="shape" />
        <feGaussianBlur result="effect1_foregroundBlur_69_17998" stdDeviation="32" />
      </filter>
    </defs>
  </svg>
);

export const GithubCopilotIcon: Icon = ({ className, ...props }) => (
  <svg
    {...props}
    preserveAspectRatio="xMidYMid"
    viewBox="0 0 256 208"
    className={cn("fill-black dark:fill-white", className)}
  >
    <path d="M205.3 31.4c14 14.8 20 35.2 22.5 63.6 6.6 0 12.8 1.5 17 7.2l7.8 10.6c2.2 3 3.4 6.6 3.4 10.4v28.7a12 12 0 0 1-4.8 9.5C215.9 187.2 172.3 208 128 208c-49 0-98.2-28.3-123.2-46.6a12 12 0 0 1-4.8-9.5v-28.7c0-3.8 1.2-7.4 3.4-10.5l7.8-10.5c4.2-5.7 10.4-7.2 17-7.2 2.5-28.4 8.4-48.8 22.5-63.6C77.3 3.2 112.6 0 127.6 0h.4c14.7 0 50.4 2.9 77.3 31.4ZM128 78.7c-3 0-6.5.2-10.3.6a27.1 27.1 0 0 1-6 12.1 45 45 0 0 1-32 13c-6.8 0-13.9-1.5-19.7-5.2-5.5 1.9-10.8 4.5-11.2 11-.5 12.2-.6 24.5-.6 36.8 0 6.1 0 12.3-.2 18.5 0 3.6 2.2 6.9 5.5 8.4C79.9 185.9 105 192 128 192s48-6 74.5-18.1a9.4 9.4 0 0 0 5.5-8.4c.3-18.4 0-37-.8-55.3-.4-6.6-5.7-9.1-11.2-11-5.8 3.7-13 5.1-19.7 5.1a45 45 0 0 1-32-12.9 27.1 27.1 0 0 1-6-12.1c-3.4-.4-6.9-.5-10.3-.6Zm-27 44c5.8 0 10.5 4.6 10.5 10.4v19.2a10.4 10.4 0 0 1-20.8 0V133c0-5.8 4.6-10.4 10.4-10.4Zm53.4 0c5.8 0 10.4 4.6 10.4 10.4v19.2a10.4 10.4 0 0 1-20.8 0V133c0-5.8 4.7-10.4 10.4-10.4Zm-73-94.4c-11.2 1.1-20.6 4.8-25.4 10-10.4 11.3-8.2 40.1-2.2 46.2A31.2 31.2 0 0 0 75 91.7c6.8 0 19.6-1.5 30.1-12.2 4.7-4.5 7.5-15.7 7.2-27-.3-9.1-2.9-16.7-6.7-19.9-4.2-3.6-13.6-5.2-24.2-4.3Zm69 4.3c-3.8 3.2-6.4 10.8-6.7 19.9-.3 11.3 2.5 22.5 7.2 27a41.7 41.7 0 0 0 30 12.2c8.9 0 17-2.9 21.3-7.2 6-6.1 8.2-34.9-2.2-46.3-4.8-5-14.2-8.8-25.4-9.9-10.6-1-20 .7-24.2 4.3ZM128 56c-2.6 0-5.6.2-9 .5.4 1.7.5 3.7.7 5.7 0 1.5 0 3-.2 4.5 3.2-.3 6-.3 8.5-.3 2.6 0 5.3 0 8.5.3-.2-1.6-.2-3-.2-4.5.2-2 .3-4 .7-5.7-3.4-.3-6.4-.5-9-.5Z" />
  </svg>
);

// Pi's colour mark (pi.dev/social.png), drawn from the pi.dev favicon paths.
export const PiIcon: Icon = ({ className, ...props }) => (
  <svg {...props} viewBox="-40 -40 640 640" className={cn("fill-none", className)}>
    <path fill="#F09082" d="M420 280H280V140H0V0H420V280Z" />
    <path fill="#4D9ABF" d="M140 560H0V140H140V280H280V420H140V560Z" />
    <path fill="#F1BE58" d="M560 560H420V280H560V560Z" />
  </svg>
);

// Oh My Pi's official mark (can1357/oh-my-pi packages/collab-web/public/favicon.svg).
export const OhMyPiIcon: Icon = ({ className, ...props }) => {
  const gradientId = useId();
  return (
    <svg {...props} viewBox="0 0 64 64" className={cn("fill-none", className)}>
      <defs>
        <linearGradient id={gradientId} x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="#ed4abf" />
          <stop offset=".5" stopColor="#9b4dff" />
          <stop offset="1" stopColor="#5ad8e6" />
        </linearGradient>
      </defs>
      <rect width="64" height="64" rx="12" fill="#0f0a14" />
      <path fill={`url(#${gradientId})`} d="M14 16h36v8H40v32h-8V24h-6v22h-8V24h-4z" />
    </svg>
  );
};

// Scient Agent's symbol: a Möbius strip blending from blue to peach. The drawing is a few hundred
// masked slices, so it is kept as an asset and shown as an image.
export const ScientAgentIcon: Icon = (props) => (
  <svg {...props} viewBox="0 0 512 512" fill="none">
    <image href={scientAgentSymbolUrl} width="512" height="512" />
  </svg>
);
