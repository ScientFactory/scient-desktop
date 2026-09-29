# Scient right-to-left clipboard fixture

Ask the agent to repeat the message between the lines exactly, as its reply.
Then copy the reply twice: once by selecting it and pressing ⌘C, and once with
**Copy message**. Paste each copy into an empty Word document, a Google Doc, and
a Pages document.

In every target, check that:

- Hebrew paragraphs, headings, list items, and the quote are right-to-left and
  right-aligned; the English paragraph and English list are left-to-right.
- Each Hebrew sentence ends with its period on the left, including the one
  that ends with an English word.
- Parentheses and quotation marks face the right way, and numbers, percentages,
  and dates keep their digit order.
- Inline code, the file paths, the URL, the equation, and the English link read
  left-to-right in one piece, with the Hebrew punctuation after them outside.
- The code block stays left-to-right, including its Hebrew comment.
- The Hebrew table reads right-to-left; the English table reads left-to-right.

Also select part of one Hebrew sentence and paste it into the middle of an
existing Hebrew line: it should join the line without starting a new paragraph.
Copy an English-only reply and confirm it pastes exactly as before.

---

## סיכום הניסוי

הרצנו את הניתוח הסטטיסטי עם Python.

המשתתפים (כ-3,400 איש) דיווחו "שיפור ניכר" ו-"no change" במקרים בודדים.

שיעור ההצלחה עלה ב-12.5% בין 01/09/2026 ל-2026-09-29.

כדי לשחזר את התוצאות יש להריץ את `npm test` מתוך התיקייה /Users/me/project/ ולפתוח את הקובץ ./src/analysis.ts, ואז לקרוא את ההסבר בכתובת https://example.com/docs/ או במדריך [the guide](https://example.com/guide).

לפי המשוואה $E = mc^2$ האנרגיה נשמרת.

- פריט ראשון ברשימה
- פריט שני עם `config.json`

The English summary paragraph stays left-to-right.

1. First English step
2. Second English step

> ציטוט קצר בעברית, עם הפניה ל-RFC 9110.

| שם    | תיאור       |  ערך |
| ----- | ----------- | ---: |
| טיפול | תרופה ומעקב | 5 mg |
| ניטור | בדיקות בבית |  30% |

| Term | Meaning        |
| ---- | -------------- |
| Dose | Amount per day |

```python
# הערה בעברית בתוך קוד
print("hello")
```

---
