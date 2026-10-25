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
  'publish.libraryTitle': 'אל הספרייה',
  'publish.libraryNote':
    'פרסום כותב לספרייה, דרך ה-API שלה, את ההעלאות שעורך אישר: עיצוב לקטלוג העיצובים עם התמונה שלו, תרגום לשקפים של העיצוב שלו, דוגמה לקטלוג התבניות, ותגיות חיפוש לקובץ התגיות של החלק שלהן. כל העלאה נבדקת שוב מול הספרייה, והאפליקציה מוצאת אותן בפעם הבאה שהיא קוראת את הספרייה.',
  'publish.publishAccepted': 'פרסום {count} לספרייה',
  'publish.publishedResult': 'פורסמו {count} העלאות. הספרייה פורסמה ב-{at}.',
  'publish.skippedResult': '{count} נשארו מאושרות:',
  'publish.liveState': 'הספרייה פורסמה ב-{at}: {files} קבצים.',
  'publish.notLive':
    'הספרייה עוד לא בדלי שלה, ולכן אי אפשר לפרסם אליה. ה-README של הספרייה, בסעיף "Publishing the uploads", מסביר איך מעבירים אותה פעם אחת.',
  'publish.acceptedCount': '{count} העלאות מאושרות ממתינות',
  'publish.noAccepted': 'אין העלאות מאושרות שממתינות לפרסום',
  'publish.refresh': 'רענן',
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
  'publish.libraryTitle': 'Into the library',
  'publish.libraryNote':
    "A publication writes the uploads an editor accepted into the library, through its API: a design into the catalog of designs with its picture, a translation into its design's slides, a sample into the catalog of templates, and search tags into the tags file of their part. Each is checked once more against the library, and the app finds them the next time it reads the library.",
  'publish.publishAccepted': 'Publish {count} to the library',
  'publish.publishedResult': '{count} uploads published. The library was published at {at}.',
  'publish.skippedResult': '{count} stayed accepted:',
  'publish.liveState': 'The library was published at {at}: {files} files.',
  'publish.notLive':
    'The library is not in its bucket yet, so nothing can be published to it. The library\'s README, "Publishing the uploads", says how to bring it in once.',
  'publish.acceptedCount': '{count} accepted uploads wait',
  'publish.noAccepted': 'No accepted uploads wait to be published',
  'publish.refresh': 'Refresh',
};
