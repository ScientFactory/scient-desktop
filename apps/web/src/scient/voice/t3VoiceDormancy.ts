/**
 * T3 voice stays dormant until the voice decision. Without a chosen destination T3 offers its
 * microphone as a first-run setup; Scient turns that offer off so its own voice control is the
 * only microphone users see.
 */
export const SCIENT_OFFERS_T3_VOICE_SETUP: boolean = false;
