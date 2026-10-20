export const he = {
  'publish.dialogLabel': 'פרסום',
  'publish.title': 'פרסום לספריית המדיה',
  'publish.close': 'סגור',
  'publish.itemsToPublish': '{count} פריטים לפרסום',
  'publish.noApproved': 'אין פריטים מאושרים',
  'publish.noteDesigns1': 'העיצובים נכנסים לקטלוג משלהם, ',
  'publish.noteDesigns2': ', עם מזהים שמתחילים ב-',
  'publish.noteDesigns3': ', לצד העיצובים שנכתבו ביד. הדוגמאות של התבניות נכנסות לקטלוג התבניות, ',
  'publish.noteDesigns4': ', כל שפה במקומה, ושום דבר אחר בקובץ לא משתנה. הפרסום עובר דרך ',
  'publish.noteDesigns5': ' של המאגר, מהעותק ',
  'publish.tokenTitle': 'מפתח Cloudflare',
  'publish.tokenHelp':
    'מפתח API עם הרשאת Cloudflare Pages: Edit. נשמר בזיכרון של השרת בלבד, לא בדיסק.',
  'publish.save': 'שמור',
  'publish.reportSummary':
    'מול הספרייה שפורסמה ({before} קבצים): {added} יתווספו, {changed} ישתנו, {removed} יוסרו. אחרי הפרסום יהיו בה {files} קבצים ({size} MB).',
  'publish.unexpectedWarn':
    'שימו לב: {count} קבצים ישתנו מעבר לפריטים האלה — יש בעותק המקומי שינויים שלא פורסמו. בדקו את הרשימה לפני שתשלחו.',
  'publish.removedWarn': '{count} קבצים שפורסמו יוסרו מהספרייה.',
  'publish.pathsAdded': 'יתווספו',
  'publish.pathsChanged': 'ישתנו',
  'publish.pathsRemoved': 'יוסרו',
  'publish.prepare': 'הכן פרסום ובדוק מה ישתנה',
  'publish.confirmSend':
    'לשלוח {count} פריטים לספרייה ב-Cloudflare? הם יופיעו אצל כל משתמשי Slidr.',
  'publish.approveSend': 'אשר ושלח ל-Cloudflare',
  'publish.cancel': 'בטל',
  'publish.needToken': 'הזינו מפתח Cloudflare כדי לשלוח.',
  'publish.log': 'יומן',
};

export const en: typeof he = {
  'publish.dialogLabel': 'Publish',
  'publish.title': 'Publish to the media library',
  'publish.close': 'Close',
  'publish.itemsToPublish': '{count} items to publish',
  'publish.noApproved': 'No approved items',
  'publish.noteDesigns1': 'Designs go into their own catalog, ',
  'publish.noteDesigns2': ', with IDs that start with ',
  'publish.noteDesigns3':
    ', alongside the hand-written designs. Template samples go into the template catalog, ',
  'publish.noteDesigns4':
    ", each language in its own place, and nothing else in the file changes. Publishing runs through the repo's ",
  'publish.noteDesigns5': ', from the copy at ',
  'publish.tokenTitle': 'Cloudflare token',
  'publish.tokenHelp':
    "An API token with the Cloudflare Pages: Edit permission. Kept in the server's memory only, never on disk.",
  'publish.save': 'Save',
  'publish.reportSummary':
    'Compared with the published library ({before} files): {added} will be added, {changed} will change, {removed} will be removed. After publishing it will hold {files} files ({size} MB).',
  'publish.unexpectedWarn':
    'Heads up: {count} files will change beyond these items, because the local copy has unpublished changes. Review the list before you send.',
  'publish.removedWarn': '{count} published files will be removed from the library.',
  'publish.pathsAdded': 'Will be added',
  'publish.pathsChanged': 'Will change',
  'publish.pathsRemoved': 'Will be removed',
  'publish.prepare': 'Prepare to publish and check what will change',
  'publish.confirmSend':
    'Send {count} items to the Cloudflare library? They will appear for all Slidr users.',
  'publish.approveSend': 'Approve and send to Cloudflare',
  'publish.cancel': 'Cancel',
  'publish.needToken': 'Enter a Cloudflare token to send.',
  'publish.log': 'Log',
};
