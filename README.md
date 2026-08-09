# iya-enrollment-dashboard
Fall 2026 Schedule of Classes IYA

## Daily data refresh (automatic, free)

GitHub Actions runs `node scripts/refresh-data.js` daily at 6:00 AM Pacific time, updates the SOC-backed enrollment snapshot in `data.js`, and pushes the change to `main` for Netlify to deploy.

## Updating room assignments (manual)

Update `roomCapacity`, `facilityMeetingData`, `facilityScheduleData`, and `excelFacilityMeetingData` in `data.js` only when the term's actual room/day/time assignments change in the room-booking spreadsheet.
