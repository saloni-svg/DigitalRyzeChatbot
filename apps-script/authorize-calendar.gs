// Run this function once from the Apps Script editor (select it, then click Run)
// so Google asks you to allow Calendar access. You can delete it afterwards.
function authorizeCalendar() {
  Logger.log("Calendar connected: " + CalendarApp.getDefaultCalendar().getName());
}
