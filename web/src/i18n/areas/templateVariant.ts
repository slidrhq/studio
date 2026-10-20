export const he = {
  'templateVariant.kindBuild': 'בנייה',
  'templateVariant.kindContract': 'חוזה',
  'templateVariant.kindError': 'שגיאה {rule}',
  'templateVariant.kindWarning': 'אזהרה {rule}',
  'templateVariant.noFindings': 'אין ממצאים לשקף הזה.',
  'templateVariant.inheritedFindings': '{count} ממצאים שיש גם בשקף שממנו נכתב, ולא נזקפים לשפה הזו',
  'templateVariant.confirmApprove':
    'בדיקת העיצוב מצאה {count} שגיאות שאין בשקפים המקוריים. לאשר לפרסום בכל זאת?',
  'templateVariant.close': 'סגור',
  'templateVariant.slideNotBuilt': 'השקף לא נבנה: {error}',
  'templateVariant.allSlides': 'כל השקפים, כפי שספריית התבניות מציגה אותם',
  'templateVariant.sheetNote':
    'כל שקף נבנה על התבנית עם המנוע של Slidr, כמו שהאפליקציה בונה את הדוגמה, ונבדק בבדיקת העיצוב שלה. ממצא שיש גם בשקף שממנו התרגום נכתב (האנגלי, או העברי לשפה מימין לשמאל) לא נזקף לשפה הזו.',
  'templateVariant.stop': 'עצור',
  'templateVariant.retry': 'נסה שוב',
  'templateVariant.approvedNote': 'הדוגמה בשפה הזו מאושרת ותישלח בפרסום הבא.',
  'templateVariant.unapprove': 'בטל אישור',
  'templateVariant.approve': 'אשר לפרסום',
  'templateVariant.notPublishable':
    'הדוגמה לא עומדת בחוזה שלה (שקף שלא נבנה, מבנה ששונה מהאנגלית, או טקסט שלא תורגם), ולכן אי אפשר לאשר אותה. בקשו תיקון.',
  'templateVariant.restore': 'החזר',
  'templateVariant.discard': 'פסול',
  'templateVariant.findings': 'ממצאים',
  'templateVariant.noRender': 'אין עדיין רינדור.',
  'templateVariant.slideLabel': 'שקף {number}: {name}',
  'templateVariant.changeRequest': 'בקשת שינוי',
  'templateVariant.feedbackPlaceholder': 'למשל: בשקף {number} הכותרת נשברת לשלוש שורות; קצרו אותה',
  'templateVariant.sendToClaude': 'שלח ל-Claude',
  'templateVariant.instructions': 'ההוראות',
  'templateVariant.log': 'יומן',
};

export const en = {
  'templateVariant.kindBuild': 'Build',
  'templateVariant.kindContract': 'Contract',
  'templateVariant.kindError': 'Error {rule}',
  'templateVariant.kindWarning': 'Warning {rule}',
  'templateVariant.noFindings': 'No findings for this slide.',
  'templateVariant.inheritedFindings':
    '{count} findings also present in the source slide, not counted against this language',
  'templateVariant.confirmApprove':
    'The design check found {count} errors that the original slides do not have. Approve for publishing anyway?',
  'templateVariant.close': 'Close',
  'templateVariant.slideNotBuilt': 'The slide was not built: {error}',
  'templateVariant.allSlides': 'All slides, as the template library shows them',
  'templateVariant.sheetNote':
    'Each slide is built on the template with the Slidr engine, the way the app builds the sample, and checked by its design check. A finding that also exists in the slide the translation was written from (the English one, or the Hebrew one for a right-to-left language) is not counted against this language.',
  'templateVariant.stop': 'Stop',
  'templateVariant.retry': 'Try again',
  'templateVariant.approvedNote':
    'The sample in this language is approved and will be sent with the next publish.',
  'templateVariant.unapprove': 'Revoke approval',
  'templateVariant.approve': 'Approve for publishing',
  'templateVariant.notPublishable':
    'The sample does not meet its contract (a slide that was not built, a structure that differs from the English one, or untranslated text), so it cannot be approved. Request a fix.',
  'templateVariant.restore': 'Restore',
  'templateVariant.discard': 'Reject',
  'templateVariant.findings': 'Findings',
  'templateVariant.noRender': 'Not rendered yet.',
  'templateVariant.slideLabel': 'Slide {number}: {name}',
  'templateVariant.changeRequest': 'Request a change',
  'templateVariant.feedbackPlaceholder':
    'For example: on slide {number} the title wraps to three lines; shorten it',
  'templateVariant.sendToClaude': 'Send to Claude',
  'templateVariant.instructions': 'Instructions',
  'templateVariant.log': 'Log',
};
