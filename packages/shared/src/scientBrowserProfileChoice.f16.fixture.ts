/**
 * Finding 16's Overleaf rows, derived from the 2026-11-03 real-account test record (steps 1, 3, 5
 * and F16), not read from the app: to be checked against the accesstest app's `accounts.snapshot`.
 * Names, addresses and ids are placeholders; secrets keep only their keys.
 */
const IMPORTED_AT = "2026-11-03T11:23:59.000Z";
const chrome = (profileName: string) => ({
  browser: "chrome",
  profileName,
  importedAt: IMPORTED_AT,
});

/** The five profiles the import made beside Main: four from Chrome, one from Safari. */
export const F16_RECORDS = [
  { profileId: "profile-yaacov", source: chrome("Yaacov") },
  { profileId: "profile-digitalowl", source: chrome("digitalowl.com") },
  { profileId: "profile-work", source: chrome("Work") },
  { profileId: "profile-datavant", source: chrome("datavant.com") },
  {
    profileId: "profile-personal",
    source: { browser: "safari", profileName: "Personal", importedAt: IMPORTED_AT },
  },
].map((record) => ({
  ...record,
  access: "allowed",
  scope: { type: "all-projects" },
  scriptSignIn: true,
}));

export const F16_WORK_USERNAME = "person@university.example";
const PASSWORD = { password: { source: { type: "scient" } } };

/** Overleaf's rows and the identity provider it signs in through, as item 2 leaves them. */
export const F16_ROWS = [
  // Saved passwords from the Chrome import: each remembers its profile, and is no evidence.
  {
    accountId: "acc_f16overleafwork",
    details: {
      kind: "website",
      sites: ["overleaf.com"],
      username: F16_WORK_USERNAME,
      profileId: "profile-work",
    },
    secrets: PASSWORD,
    createdAt: "2026-11-03T11:24:30.000Z",
  },
  {
    accountId: "acc_f16overleafyaacov",
    details: {
      kind: "website",
      sites: ["overleaf.com"],
      username: "person@mail.example",
      profileId: "profile-yaacov",
    },
    secrets: PASSWORD,
    createdAt: "2026-11-03T11:24:31.000Z",
  },
  // Item 2's passwordless row with a username: the session the Work profile was seen to hold.
  {
    accountId: "acc_f16overleafsession",
    details: {
      kind: "website",
      sites: ["overleaf.com"],
      username: F16_WORK_USERNAME,
      profileId: "profile-work",
      origin: "browser-session",
    },
    secrets: {},
    signIn: { state: "signed-in", at: "2026-11-03T11:42:15.000Z" },
    createdAt: "2026-11-03T11:42:15.000Z",
  },
  // The university sign-in (step 5), made in the Yaacov profile.
  {
    accountId: "acc_f16university",
    details: {
      kind: "website",
      sites: ["university.example", "https://idp.university.example"],
      profileId: "profile-yaacov",
    },
    secrets: {},
    signIn: { state: "signed-in", at: "2026-11-03T11:52:00.000Z" },
    createdAt: "2026-11-03T11:51:00.000Z",
  },
];
