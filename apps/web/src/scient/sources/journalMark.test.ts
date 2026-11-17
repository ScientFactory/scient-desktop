import { describe, expect, it } from "vite-plus/test";

import { JOURNAL_MARK_TONES, journalMarkLetters, journalMarkTone } from "./journalMark";

// Real names from the 372-venue qualification corpus, plus scripts it lacked.
const CASES: ReadonlyArray<readonly [string, string | null]> = [
  // Initials of up to four words.
  ["New England Journal of Medicine", "NEJM"],
  ["The New England Journal of Medicine", "NEJM"],
  ["N Engl J Med", "NEJM"],
  ["Journal of Clinical Investigation", "JCI"],
  ["J Clin Invest", "JCI"],
  ["Annals of Internal Medicine", "AIM"],
  ["Scientific Reports", "SR"],
  ["Nature Methods", "NM"],
  ["Nat Med", "NM"],
  ["Journal of the American Medical Association", "JAMA"],
  ["Journal of the American Chemical Society", "JACS"],
  ["Nucleic Acids Research", "NAR"],
  ["Physical Review Letters", "PRL"],
  ["Medicine and Science in Sports and Exercise", "MSSE"],
  ["Cell Death and Disease", "CDD"],
  ["Cell Stress and Chaperones", "CSC"],
  ["Journal of the American College of Cardiology", "JACC"],
  ["Journal of the American College of Nutrition", "JACN"],
  // More than four words keep the distinguishing last one.
  ["IEEE Transactions on Information Technology in Biomedicine", "ITIB"],
  ["American Journal of Respiratory and Critical Care Medicine", "AJRM"],
  ["Ann N Y Acad Sci", "ANAS"],
  // One word.
  ["JAMA", "JAMA"],
  ["BMJ", "BMJ"],
  ["The BMJ", "BMJ"],
  ["Nature", "N"],
  ["Cell", "C"],
  ["The Lancet", "L"],
  ["Science", "S"],
  ["eLife", "E"],
  ["Noûs", "N"],
  // Acronyms inside longer names.
  ["IEEE Access", "IA"],
  ["IEEE Transactions on Computers", "ITC"],
  ["ACM Computing Surveys", "ACS"],
  ["ACM SIGCSE Bulletin", "ASB"],
  ["PLoS ONE", "PO"],
  ["PLOS ONE", "PO"],
  ["BMJ Open", "BO"],
  ["JNCI Journal of the National Cancer Institute", "JNCI"],
  ["JNPM (Jurnal Nasional Pendidikan Matematika)", "JNPM"],
  ["2016 IEEE Conference on Computer Vision and Pattern Recognition (CVPR)", "CVPR"],
  ["TED EĞİTİM VE BİLİM", "TEVB"],
  // Series letters.
  ["Physical Review", "PR"],
  ["Physical Review A", "PRA"],
  ["Physical Review B", "PRB"],
  ["Physical review. B, Condensed matter", "PRB"],
  ["Phys Rev E", "PRE"],
  ["Physical Review X", "PRX"],
  ["Physical review. D/Physical review. D.", "PRD"],
  ["Proceedings of the Royal Society B Biological Sciences", "PRSB"],
  ["Proceedings of the Royal Society A Mathematical Physical and Engineering Sciences", "PRSA"],
  ["Journal of Physics A: Mathematical and Theoretical", "JPA"],
  ["Chemistry - A European Journal", "CEJ"],
  // Subtitles and brackets.
  ["Journal of the Chemical Society (Resumed)", "JCS"],
  ["Lancet: Oncology", "L"],
  // Other languages.
  ["Revista Española de Cardiología", "REC"],
  ["Ciência & Saúde Coletiva", "CSC"],
  ["Geochimica et Cosmochimica Acta", "GCA"],
  ["Archiv der Mathematik", "AM"],
  ["Zeitschrift für Morphologie und Ökologie der Tiere", "ZMÖT"],
  ["De Economist", "E"],
  ["Вестник Московского университета", "ВМУ"],
  ["中华医学杂志", "中"],
  ["مجلة العلوم", "م"],
  ["כתב עת לרפואה", "כ"],
  // Aliases.
  ["Proceedings of the National Academy of Sciences", "PNAS"],
  ["Proceedings of the National Academy of Sciences of the United States of America", "PNAS"],
  ["Proc Natl Acad Sci U S A", "PNAS"],
  ["Proc Natl Acad Sci USA", "PNAS"],
  ["Journal of the National Cancer Institute", "JNCI"],
  ["J Natl Cancer Inst", "JNCI"],
  ["IEEE Transactions on Pattern Analysis and Machine Intelligence", "PAMI"],
  ["IEEE Trans Pattern Anal Mach Intell", "PAMI"],
  ["Communications of the ACM", "CACM"],
  ["Commun ACM", "CACM"],
  // Nothing to show.
  ["", null],
  ["  ", null],
  ["2024", null],
  ["—", null],
];

const graphemeCount = (text: string) =>
  [...new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(text)].length;

describe("journalMarkLetters", () => {
  it.each(CASES)("%s → %s", (name, expected) => {
    expect(journalMarkLetters(name)).toBe(expected);
  });

  it("never gives more than four letters", () => {
    for (const [name] of CASES) {
      const mark = journalMarkLetters(name);
      if (mark) expect(graphemeCount(mark)).toBeLessThanOrEqual(4);
    }
    expect(journalMarkLetters("Alpha Beta Gamma Delta Epsilon Zeta Eta")).toBe("ABGE");
  });
});

/** WCAG relative luminance contrast of two #rrggbb colours. */
function contrast(first: string, second: string): number {
  const luminance = (hex: string) => {
    const [r, g, b] = [1, 3, 5].map((start) => {
      const channel = Number.parseInt(hex.slice(start, start + 2), 16) / 255;
      return channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
    });
    return 0.2126 * r! + 0.7152 * g! + 0.0722 * b!;
  };
  const [light, dark] = [luminance(first), luminance(second)].toSorted((a, b) => b - a);
  return (light! + 0.05) / (dark! + 0.05);
}

describe("journalMarkTone", () => {
  it("gives a title the same tone however it is written, and ignores nothing else", () => {
    expect(journalMarkTone("The New England Journal of Medicine")).toBe(
      journalMarkTone("new england journal of medicine."),
    );
    const tones = new Set(
      ["Nature", "Cell", "Science", "JAMA", "BMJ", "PLOS ONE", "eLife", "Physical Review B"].map(
        journalMarkTone,
      ),
    );
    expect(tones.size).toBeGreaterThan(1);
  });

  it("keeps every tone readable in light and dark", () => {
    for (const tone of JOURNAL_MARK_TONES) {
      expect(contrast(tone.light.background, tone.light.text)).toBeGreaterThanOrEqual(4.5);
      expect(contrast(tone.dark.background, tone.dark.text)).toBeGreaterThanOrEqual(4.5);
    }
  });
});
