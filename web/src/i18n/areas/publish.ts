export const he = {
  'publish.dialogLabel': 'פרסום',
  'publish.title': 'פרסום לספריית המדיה',
  'publish.close': 'סגור',
  'publish.itemsToPublish': '{count} פריטים לפרסום',
  'publish.noApproved': 'אין פריטים מאושרים',
  'publish.save': 'שמור',
  'publish.uploadNote':
    'כל עיצוב מאושר נשלח ל-API ההעלאות של הספרייה כעיצוב חדש, עם השקפים, השמות ותגיות החיפוש שלו, וכל דוגמה נשלחת כתבנית שלה בשפה נוספת. הספרייה בודקת אותו מול מה שהיא מפרסמת ושומרת אותו עד שעורך מאשר אותו, ומשם הוא מתפרסם.',
  'publish.keyTitle': 'המפתח של הספרייה',
  'publish.keyHelp':
    'המפתח של הסטודיו ל-API של הספרייה: ⁦studio=<key>⁩ ב-⁦LIBRARY_KEYS⁩ של ה-Worker שלה. נשמר במנהל האישורים של Windows במחשב הזה.',
  'publish.upload': 'שליחת {count} לספרייה',
  'publish.waiting': 'ממתין בספרייה בתור',
  'publish.refused': 'הספרייה לא קיבלה אותו: {error}',
  'publish.openLibrary': 'ההעלאות בספרייה',
};

export const en: typeof he = {
  'publish.dialogLabel': 'Publish',
  'publish.title': 'Publish to the media library',
  'publish.close': 'Close',
  'publish.itemsToPublish': '{count} items to publish',
  'publish.noApproved': 'No approved items',
  'publish.save': 'Save',
  'publish.uploadNote':
    "Each approved design goes to the library's upload API as a new design, with its slides, its names and its search tags; each sample as its template in another language. The library checks it against what it publishes and keeps it until an editor accepts it; it is published from there.",
  'publish.keyTitle': "The library's key",
  'publish.keyHelp':
    "The studio's key to the library's API: studio=<key> in its Worker's LIBRARY_KEYS. Kept in Windows' Credential Manager on this computer.",
  'publish.upload': 'Send {count} to the library',
  'publish.waiting': 'Waits in the library as',
  'publish.refused': 'The library did not take it: {error}',
  'publish.openLibrary': 'The uploads in the library',
};
