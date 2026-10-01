/**
 * Tartan → Google Calendar.
 *
 * Deployed as a web app that runs AS the owner, so Google itself holds the reminders. Tartan
 * only has to be awake long enough to POST; everything that must happen at 9am on a Tuesday
 * happens on Google's side with the laptop shut.
 *
 * Two things carry the whole design:
 *
 *  1. Every event Tartan owns has "TartanSync id=<id>" on the last line of its description. That
 *     is the index. Nothing else on the calendar is ever touched, and an event that has drifted
 *     into the past still counts as "already there" — an index that only looked forward would
 *     quietly re-create every deadline that had gone by.
 *
 *  2. Reminders are set explicitly on every event. An event created with no reminders inherits
 *     the calendar's default list, and if that list is empty the event lands, looks perfect on
 *     every device, and alerts nobody. removeAllReminders() followed by addPopupReminder() is
 *     the difference between a calendar that notifies and one that only looks like it does.
 *
 * Todos go to Google Tasks instead, into their own list, and only if the Tasks advanced service
 * has been added in the editor. Without it the calendar half still works.
 */

var MARKER = 'TartanSync';
var PROP_SECRET = 'TARTAN_SECRET';
var PROP_CLASSES = 'TARTAN_CLASSES_HASH';

/** How far either side of today to index. Past events must stay indexed or they get duplicated. */
var WINDOW_DAYS = 400;

/**
 * Minutes before the event starts. Edit these two lines to change every reminder at once.
 *
 * A timed deadline gets the day-before heads-up that lets you actually start the work, then the
 * three closing nudges. An all-day deadline starts at MIDNIGHT, so the same numbers would fire at
 * 11pm, 11:30pm and 11:45pm the night before — useless. All-day work is nudged during waking
 * hours instead. Give a deadline a time in Tartan if you want the 60/30/15 sequence on it.
 */
var REMIND_TIMED = [1440, 60, 30, 15];
var REMIND_ALL_DAY = [900, 240];

/* ------------------------------------------------------------------ entry points */

/**
 * The phone page, and the liveness check — both served by the ONE deployment Tartan already
 * posts to. With ?k=<TARTAN_VIEW_KEY> the page renders; without it the URL answers one flat line
 * and nothing else. (It used to answer "Writing to: <the owner's email address>" to anybody.)
 *
 * The page is built from the CALENDAR, not from a stored copy of the last payload. Every event the
 * sync owns already carries "TartanSync id=…" in its description, so the page and the phone's own
 * calendar notifications are reading the same rows and cannot drift apart. It also needs no new
 * OAuth scope, which is what keeps the redeploy version-only.
 */
function doGet(e) {
  if (!viewKeyOk_(e)) {
    return ContentService.createTextOutput('Tartan sync is alive. ' + new Date());
  }
  var out = HtmlService.createHtmlOutput(pageHtml_(new Date(), e.parameter.k)).setTitle('Tartan');
  // Apps Script ignores a <meta viewport> written inside the HTML string. THESE calls are what
  // actually reach the served page. viewport-fit=cover + the safe-area padding in the CSS is what
  // lets the page run under the iPhone notch; apple-mobile-web-app-capable makes an added-to-
  // home-screen bookmark open full screen, like an app. addMetaTag REJECTS names outside its
  // small allow-list by throwing — and a meta tag is never worth taking the whole page down, so
  // each one is guarded ('mobile-web-app-capable' and the -title variant already died that way).
  meta_(out, 'viewport', 'width=device-width, initial-scale=1, viewport-fit=cover');
  meta_(out, 'apple-mobile-web-app-capable', 'yes');
  return out;
}

function meta_(out, name, value) {
  try {
    out.addMetaTag(name, value);
  } catch (err) {
    // Not on the allow-list. The page renders fine without it.
  }
}

/**
 * The one and only door: the bookmark carries ?k= matching the TARTAN_VIEW_KEY script property.
 * No Google sign-in - deliberately. Session.getActiveUser() refuses to identify visitors on
 * personal accounts even when the visitor owns the script, so every identity-based gate failed in
 * the field. The link itself is the password: the page loads no external resources, so the key
 * cannot leak through a Referer. Without ?k= the URL answers with one flat line and nothing else.
 */
function viewKeyOk_(e) {
  try {
    var key = PropertiesService.getScriptProperties().getProperty('TARTAN_VIEW_KEY');
    var given = String((e && e.parameter && e.parameter.k) || '');
    return !!key && given === key;
  } catch (err) {
    return false;
  }
}

/**
 * PUBLIC - the phone page's refresh, via google.script.run. location.reload() inside the HtmlService
 * sandbox reloads the iframe WITHOUT re-running doGet, so "refresh" re-showed the page exactly as
 * first served, and a home-screen bookmark resumed that for days. The page asks for the stale half
 * here instead and swaps it in. Same door as doGet: the view key, or nothing.
 */
function pageRefresh(k) {
  if (!viewKeyOk_({ parameter: { k: k } })) throw new Error('Not allowed.');
  return pageData_(new Date());
}

function doPost(e) {
  var out;
  try {
    if (!e || !e.postData || !e.postData.contents) throw new Error('Empty request body.');
    var body = JSON.parse(e.postData.contents);
    var secret = PropertiesService.getScriptProperties().getProperty(PROP_SECRET);
    if (!secret) throw new Error('Script property ' + PROP_SECRET + ' is not set.');
    if (String(body.secret || '') !== secret) throw new Error('Bad secret.');
    // A poll carries no semester and does no calendar work: it acks what Tartan has applied and
    // hands back whatever the phone has queued since. Cheap enough to fire on every window focus.
    out = body.poll ? inboxPoll_(body.applied) : sync_(body);
    out.ok = true;
  } catch (err) {
    out = { ok: false, error: String((err && err.message) || err) };
  }
  return ContentService.createTextOutput(JSON.stringify(out)).setMimeType(ContentService.MimeType.JSON);
}

/** Run this once from the editor to trigger the authorisation prompt before you deploy. */
function authorise() {
  Logger.log('Calendar: ' + CalendarApp.getDefaultCalendar().getName());
}

/* ------------------------------------------------------------------ sync */

function sync_(body) {
  var cal = CalendarApp.getDefaultCalendar();
  var now = new Date();
  var from = new Date(now.getTime() - WINDOW_DAYS * 86400000);
  var to = new Date(now.getTime() + WINDOW_DAYS * 86400000);

  var found = index_(cal, from, to);
  var result = updateDeadlines_(cal, body.deadlines || [], found.deadlines);

  // Classes are rebuilt wholesale, so they get their own hash: adding one pset must not churn
  // twenty recurring series. The empty-index check re-creates them if they were deleted by hand.
  var props = PropertiesService.getScriptProperties();
  // The full set of space codes, straight from courses.json. The page treats a "<code>: " title
  // prefix as a tag only when the code is on this list (or is CMU-number-shaped, the pre-list
  // fallback), so a title like "Reading: chapter 3" never grows a phantom tag.
  try {
    if (body.codes && body.codes.length) props.setProperty('TARTAN_CODES', JSON.stringify(body.codes));
  } catch (ignore) {}
  var wanted = String(body.classesHash || '');
  var classes = body.classes || [];
  // body.rebuild is set by "Re-send everything". Without it, clearing Tartan's local hash still
  // left THIS hash matching, so a hand-deleted series was never restored unless every single one
  // had gone. Poisoning the hash instead would cause a rebuild on every subsequent sync.
  var stale = props.getProperty(PROP_CLASSES) !== wanted || body.rebuild === true;
  var missing = classes.length > 0 && found.classSeriesIds.length === 0;

  if (stale || missing) {
    var built = rebuildClasses_(cal, classes, body.termStart, body.termEnd, found.classSeriesIds);
    props.setProperty(PROP_CLASSES, wanted);
    result.classes = 'rebuilt: ' + built.created + ' series, ' + built.removed + ' replaced';
  } else {
    result.classes = 'unchanged';
  }

  // Tasks is the optional half and must never take the calendar down with it. If the advanced
  // service is missing, or the API is not enabled on the hidden Cloud project, that shows up as a
  // line in the response rather than a failed sync.
  try {
    result.todos = syncTodos_(body.todos || []);
  } catch (err) {
    result.todos = 'failed: ' + String((err && err.message) || err);
  }

  result.calendar = cal.getName();
  return result;
}

/**
 * Todos → a dedicated "Tartan" list in Google Tasks. One way only: ticking something off on the
 * phone does NOT come back to the desktop, and the next sync will re-open it. Tartan is the
 * source of truth.
 *
 * Degrades instead of failing. Adding the Tasks advanced service is a separate click in the
 * editor, so until it is added this returns a note and the calendar half keeps working.
 */
function syncTodos_(todos) {
  if (typeof Tasks === 'undefined' || !Tasks.Tasklists) {
    return 'skipped (add Services ▸ + ▸ Tasks API in the editor)';
  }

  var listId = tartanTaskList_();
  var re = new RegExp(MARKER + ' id=(\\S+)');
  var existing = {};
  var pageToken = null;

  do {
    // Completed tasks are hidden by default; without these flags a ticked-off todo looks missing
    // and gets inserted a second time.
    var page = Tasks.Tasks.list(listId, {
      showCompleted: true,
      showHidden: true,
      maxResults: 100,
      pageToken: pageToken,
    });
    var items = page.items || [];
    for (var i = 0; i < items.length; i++) {
      var found = re.exec(items[i].notes || '');
      if (found) existing[found[1]] = items[i];
    }
    pageToken = page.nextPageToken;
  } while (pageToken);

  var created = 0;
  var updated = 0;
  var removed = 0;
  var seen = {};

  for (var j = 0; j < todos.length; j++) {
    var t = todos[j];
    if (!t || !t.id) continue;
    seen[t.id] = true;

    var title = (t.course ? t.course + ': ' : '') + t.text;
    var body = {
      title: title,
      notes: MARKER + ' id=' + t.id,
      status: t.done ? 'completed' : 'needsAction',
    };
    if (t.due) body.due = t.due + 'T00:00:00.000Z';

    var prev = existing[t.id];
    if (!prev) {
      Tasks.Tasks.insert(body, listId);
      created++;
      continue;
    }

    var wasDone = prev.status === 'completed';
    var sameDue = String(prev.due || '').slice(0, 10) === String(t.due || '');
    if (prev.title === title && wasDone === !!t.done && sameDue) continue;

    // update() replaces the whole resource, which is what clears the completion date when a
    // todo is re-opened — patch() leaves a stale "completed" behind.
    body.id = prev.id;
    Tasks.Tasks.update(body, listId, prev.id);
    updated++;
  }

  for (var id in existing) {
    if (seen[id]) continue;
    Tasks.Tasks.remove(listId, existing[id].id);
    removed++;
  }

  return created + ' added, ' + updated + ' updated, ' + removed + ' removed';
}

/** Its own list, so nothing Tartan does can touch a task you made yourself. */
function tartanTaskList_() {
  var lists = Tasks.Tasklists.list({ maxResults: 100 }).items || [];
  for (var i = 0; i < lists.length; i++) {
    if (lists[i].title === 'Tartan') return lists[i].id;
  }
  return Tasks.Tasklists.insert({ title: 'Tartan' }).id;
}

/** One read of the window; every decision after this is local. */
function index_(cal, from, to) {
  var re = new RegExp(MARKER + ' id=(\\S+)');
  var deadlines = {};
  var seen = {};
  var seriesIds = [];

  var events = cal.getEvents(from, to);
  for (var i = 0; i < events.length; i++) {
    var found = re.exec(events[i].getDescription() || '');
    if (!found) continue;
    var id = found[1];
    if (id.indexOf('class-') === 0) {
      var sid = seriesIdOf(events[i].getId());
      if (!seen[sid]) {
        seen[sid] = true;
        seriesIds.push(sid);
      }
    } else {
      if (!deadlines[id]) deadlines[id] = [];
      deadlines[id].push(events[i]);
    }
  }
  return { deadlines: deadlines, classSeriesIds: seriesIds };
}

function updateDeadlines_(cal, deadlines, existing) {
  var created = 0;
  var updated = 0;
  var deleted = 0;
  var seen = {};

  for (var i = 0; i < deadlines.length; i++) {
    var d = deadlines[i];
    if (!d || !d.id) continue;
    seen[d.id] = true;

    var allDay = /^\d{4}-\d{2}-\d{2}$/.test(String(d.due));
    var start = allDay ? dateOnly(d.due) : new Date(d.due);
    if (isNaN(start.getTime())) continue;
    var end = allDay ? null : new Date(start.getTime() + 30 * 60000);

    var title = (d.done ? '✓ ' : '') + (d.course ? d.course + ': ' : '') + d.title;
    var description = (d.notes ? d.notes + '\n\n' : '') + MARKER + ' id=' + d.id;

    var list = existing[d.id] || [];
    // A duplicate can only come from an earlier half-finished run. Collapse it rather than
    // leave two events that both look right.
    for (var k = 1; k < list.length; k++) {
      list[k].deleteEvent();
      deleted++;
    }

    var ev = list[0];
    var fresh = false;
    if (!ev) {
      ev = allDay ? cal.createAllDayEvent(title, start) : cal.createEvent(title, start, end);
      created++;
      fresh = true;
    } else {
      if (ev.getTitle() !== title) ev.setTitle(title);
      if (ev.isAllDayEvent() !== allDay || ev.getStartTime().getTime() !== start.getTime()) {
        if (allDay) ev.setAllDayDate(start);
        else ev.setTime(start, end);
      }
      updated++;
    }
    if (ev.getDescription() !== description) ev.setDescription(description);

    // Ticked off means the reminders stop, but the event stays: it is a record of when the
    // work was actually due.
    applyReminders_(ev, d.done ? [] : allDay ? REMIND_ALL_DAY : REMIND_TIMED, fresh);
  }

  // Anything Tartan made that Tartan no longer knows about was deleted on the desktop.
  for (var id in existing) {
    if (seen[id] || id.indexOf('class-') === 0) continue;
    var gone = existing[id];
    for (var j = 0; j < gone.length; j++) {
      gone[j].deleteEvent();
      deleted++;
    }
  }

  return { created: created, updated: updated, deleted: deleted };
}

/**
 * A fresh event carries the calendar's defaults until told otherwise, so a new event always gets
 * the explicit write even when the wanted list is empty.
 */
function applyReminders_(event, minutes, force) {
  if (!force && sameMinutes(event.getPopupReminders() || [], minutes)) return;
  event.removeAllReminders();
  for (var i = 0; i < minutes.length; i++) event.addPopupReminder(minutes[i]);
}

function rebuildClasses_(cal, classes, termStart, termEnd, existingSeriesIds) {
  var removed = 0;
  for (var i = 0; i < existingSeriesIds.length; i++) {
    try {
      var old = CalendarApp.getEventSeriesById(existingSeriesIds[i]);
      if (old) {
        old.deleteEventSeries();
        removed++;
      }
    } catch (err) {
      // Already deleted by hand. Nothing to undo.
    }
  }

  var termFirst = dateOnly(termStart);
  var termLast = dateOnly(termEnd);
  if (isNaN(termFirst.getTime()) || isNaN(termLast.getTime())) throw new Error('Term dates are not YYYY-MM-DD.');

  var created = 0;
  for (var j = 0; j < classes.length; j++) {
    var c = classes[j];
    // Each class carries its own window. A mini course shares a time slot with another for half
    // the term, so bounding every series by the term would put both on the calendar all semester.
    var first = c.from ? dateOnly(c.from) : termFirst;
    var last = c.until ? dateOnly(c.until) : termLast;
    if (isNaN(first.getTime())) first = termFirst;
    if (isNaN(last.getTime())) last = termLast;

    var day0 = nextWeekday(first, c.day);
    if (day0.getTime() > last.getTime()) continue;

    var starts = at(day0, c.start);
    var ends = at(day0, c.end);
    if (ends.getTime() <= starts.getTime()) continue;

    // until() is exclusive, so push it past the last teaching day.
    var rule = CalendarApp.newRecurrence().addWeeklyRule().until(new Date(last.getTime() + 86400000));
    var series = cal.createEventSeries(c.code + (c.title ? ' · ' + c.title : ''), starts, ends, rule, {
      location: c.location || '',
      description: MARKER + ' id=' + c.id,
    });

    // Explicitly no reminders. Left implicit these would inherit the calendar's defaults and
    // buzz twenty times a week for classes you are already walking to.
    series.removeAllReminders();
    created++;
  }
  return { removed: removed, created: created };
}

/* ------------------------------------------------------------------ helpers */

/** An occurrence id is <base>_<stamp>@google.com; the series wants <base>@google.com. */
function seriesIdOf(id) {
  var s = String(id);
  var at = s.indexOf('@');
  var head = at === -1 ? s : s.slice(0, at);
  var tail = at === -1 ? '' : s.slice(at);
  var underscore = head.indexOf('_');
  if (underscore !== -1) head = head.slice(0, underscore);
  return head + tail;
}

/** Tartan stores Mon=0 … Sun=6; JavaScript's getDay() is Sun=0. */
function nextWeekday(from, day) {
  var d = new Date(from.getTime());
  for (var i = 0; i < 7; i++) {
    if ((d.getDay() + 6) % 7 === day) return d;
    d.setDate(d.getDate() + 1);
  }
  return d;
}

function at(date, hhmm) {
  var d = new Date(date.getTime());
  d.setHours(parseInt(String(hhmm).slice(0, 2), 10), parseInt(String(hhmm).slice(3, 5), 10), 0, 0);
  return d;
}

/** Local midnight in the SCRIPT's timezone — set it to America/New_York in Project Settings. */
function dateOnly(iso) {
  var p = String(iso).split('-');
  return new Date(Number(p[0]), Number(p[1]) - 1, Number(p[2]));
}

function sameMinutes(a, b) {
  if (a.length !== b.length) return false;
  var x = a.slice().sort(ascending);
  var y = b.slice().sort(ascending);
  for (var i = 0; i < x.length; i++) if (x[i] !== y[i]) return false;
  return true;
}

function ascending(p, q) {
  return p - q;
}

/* ------------------------------------------------------------------ the phone page */

var PAGE_DAYS = 7; // how far forward "this week" reaches
var BACK_DAYS = 14; // how far back to hunt for overdue work

/* GENERATED — the desktop's own parseEntry, bundled from src/shared/types.ts so the page's live
 * preview cannot disagree with what Tartan will do with the line. Regenerate after any parser
 * change with:  node docs/apps-script/build-parser.mjs  (splices this line in place). */
var PARSER_JS_ = 'var TP=(()=>{var E=Object.defineProperty;var C=Object.getOwnPropertyDescriptor;var M=Object.getOwnPropertyNames;var K=Object.prototype.hasOwnProperty;var z=(n,o)=>{for(var g in o)E(n,g,{get:o[g],enumerable:!0})},F=(n,o,g,m)=>{if(o&&typeof o=="object"||typeof o=="function")for(let s of M(o))!K.call(n,s)&&s!==g&&E(n,s,{get:()=>o[s],enumerable:!(m=C(o,s))||m.enumerable});return n};var O=n=>F(E({},"__esModule",{value:!0}),n);var Q={};z(Q,{everyLabel:()=>R,parseEntry:()=>L});var v=["Mon","Tue","Wed","Thu","Fri","Sat","Sun"];function R(n){return n.length===7?"every day":`every ${n.map(o=>v[o]).join(" & ")}`}var j={pset:"pset",psets:"pset",hw:"pset",homework:"pset",assignment:"pset",lab:"pset",exam:"exam",midterm:"exam",final:"exam",finals:"exam",quiz:"quiz",reading:"reading",read:"reading",chapter:"reading",admin:"admin",form:"admin",email:"admin"},A=["sunday","monday","tuesday","wednesday","thursday","friday","saturday"],Y=["jan","feb","mar","apr","may","jun","jul","aug","sep","oct","nov","dec"],y=n=>String(n).padStart(2,"0"),_=n=>`${n.getFullYear()}-${y(n.getMonth()+1)}-${y(n.getDate())}`,q=n=>n.toLocaleDateString(void 0,{weekday:"short",month:"short",day:"numeric"});function L(n,o,g={}){let m=g.now??new Date,s=new Set((g.ignore??[]).map(r=>r.toLowerCase())),i=new Array(n.length).fill(!1),e=new Array(n.length).fill(!1),d=[],t=(r,l)=>{for(let b=r;b<l;b++)if(i[b])return!1;return!0},a=(r,l,b,f,T=!1)=>{let k=n.slice(r,l);if(s.has(H(b,k))||!t(r,l))return!1;for(let w=r;w<l;w++)i[w]=!0,T||(e[w]=!0);return d.push({start:r,end:l,text:k,type:b,label:f}),!0},u=null;for(let r of o){let l=r.code.replace(/[^A-Za-z0-9]/g,""),f=new RegExp(`(?<![\\\\w-])#?(${I(r.code)}|${I(l)})(?![\\\\w-])`,"i").exec(n);if(f&&f.index!==void 0&&a(f.index,f.index+f[0].length,"course",r.code)){u=r.id;break}}let c="other";for(let r of n.matchAll(/\\b[a-z]+\\b/gi)){let l=j[r[0].toLowerCase()];if(!(!l||r.index===void 0)&&a(r.index,r.index+r[0].length,"kind",B[l],!0)){c=l;break}}let h=W(n,t,a,(r,l)=>{for(let b=r;b<l;b++)i[b]=!0}),x=h?null:P(n,m,t,a),p=x||h?U(n,t,a):null,S="";x&&(p?(x.setHours(p.h,p.m,0,0),S=x.toISOString()):S=_(x));let D=n.split("").map((r,l)=>e[l]?" ":r).join("").replace(/\\s+/g," ").replace(/\\s+([,.;:])/g,"$1").trim();for(let r=0;r<3;r++){let l=D.replace(/[\\s,–-]*\\b(due|by|on|at|before|until|till)\\b[\\s,]*$/i,"").trim();if(l===D)break;D=l}return{title:D,courseId:u,kind:c,due:S,every:h?{days:h,...p?{time:`${y(p.h)}:${y(p.m)}`}:{}}:null,spans:d.sort((r,l)=>r.start-l.start)}}function W(n,o,g,m){let s="(?:sun|mon|tues?|wed(?:nes)?|thur?s?|fri|sat(?:ur)?)(?:day)?s?",e=new RegExp(`\\\\bevery\\\\s+(day|${s}(?:\\\\s*(?:,|and|&)\\\\s*${s}|\\\\s+${s})*)\\\\b`,"i").exec(n);if(!e||e.index===void 0||!o(e.index,e.index+e[0].length))return null;let d;if(e[1].toLowerCase()==="day")d=[0,1,2,3,4,5,6];else{let a=new Set;for(let u of e[1].toLowerCase().matchAll(/[a-z]+/g)){let c=A.findIndex($=>$.startsWith(u[0].slice(0,3)));c>=0&&a.add((c+6)%7)}if(d=[...a].sort((u,c)=>u-c),!d.length)return null}let t=d.length===7?"Every day":`Every ${d.map(a=>v[a]).join(" & ")}`;return g(e.index,e.index+e[0].length,"every",t)?d:(m(e.index,e.index+e[0].length),null)}var I=n=>n.replace(/[.*+?^${}()|[\\]\\\\]/g,"\\\\$&"),H=(n,o)=>`${n}:${o.toLowerCase()}`;function P(n,o,g,m){let i=(t=>new Date(t.getFullYear(),t.getMonth(),t.getDate()))(o),e=(t,a)=>{let u=t.exec(n);if(!u||u.index===void 0||!g(u.index,u.index+u[0].length))return null;let c=a(u);return!c||Number.isNaN(c.getTime())?null:m(u.index,u.index+u[0].length,"date",q(c))?c:null},d=t=>{let a=new Date(i);return a.setDate(a.getDate()+t),a};return e(/\\b(today|tonight)\\b/i,()=>new Date(i))??e(/\\b(tomorrow|tmrw|tmr)\\b/i,()=>d(1))??e(/\\bin\\s+(\\d{1,3})\\s+days?\\b/i,t=>d(Number(t[1])))??e(/(?<!\\w)\\+(\\d{1,3})d\\b/i,t=>d(Number(t[1])))??e(/\\bnext\\s+(sun|mon|tues?|wed(?:nes)?|thur?s?|fri|sat(?:ur)?)(?:day)?\\b/i,t=>N(t[1],i,!0))??e(/\\b(sun|mon|tues?|wed(?:nes)?|thur?s?|fri|sat(?:ur)?)(?:day)?\\b/i,t=>N(t[1],i,!1))??e(/\\b(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\\.?\\s+(\\d{1,2})\\b/i,t=>{let a=Y.indexOf(t[1].slice(0,3).toLowerCase()),u=Number(t[2]);if(a<0||u<1||u>31)return null;let c=a<i.getMonth()?i.getFullYear()+1:i.getFullYear();return new Date(c,a,u)})??e(/(?<![\\d/-])(\\d{1,2})\\/(\\d{1,2})(?:\\/(\\d{2,4}))?(?![\\d/-])/,t=>{let a=Number(t[1])-1,u=Number(t[2]);if(a<0||a>11||u<1||u>31)return null;let c=t[3]?t[3].length===2?2e3+Number(t[3]):Number(t[3]):i.getFullYear();return new Date(c,a,u)})}function N(n,o,g){let m=n.toLowerCase(),s=A.findIndex(d=>d.startsWith(m.slice(0,3)));if(s<0)return o;let i=new Date(o),e=(s-i.getDay()+7)%7;return e===0&&(e=7),i.setDate(i.getDate()+e+(g?7:0)),i}function U(n,o,g){let m=(s,i)=>{let e=s.exec(n);if(!e||e.index===void 0||!o(e.index,e.index+e[0].length))return null;let d=i(e);if(!d)return null;let t=`${d.h%12===0?12:d.h%12}:${y(d.m)}${d.h<12?"am":"pm"}`;return g(e.index,e.index+e[0].length,"time",t)?d:null};return m(/\\b(?:at\\s+)?(\\d{1,2})(?::(\\d{2}))?\\s*(am|pm)\\b/i,s=>{let i=Number(s[1])%12;s[3].toLowerCase()==="pm"&&(i+=12);let e=s[2]?Number(s[2]):0;return e>59?null:{h:i,m:e}})??m(/\\b(?:at\\s+)?(\\d{1,2}):(\\d{2})\\b/,s=>{let i=Number(s[1]),e=Number(s[2]);return i>23||e>59?null:{h:i,m:e}})}var B={pset:"Problem set",exam:"Exam",quiz:"Quiz",reading:"Reading",admin:"Admin",other:"Other"};return O(Q);})();';

/** Space codes pushed by the last sync; empty until one runs. Class titles add to it per page. */
function knownCodes_() {
  var out = {};
  try {
    var raw = PropertiesService.getScriptProperties().getProperty('TARTAN_CODES');
    if (raw) {
      var list = JSON.parse(raw);
      for (var i = 0; i < list.length; i++) out[list[i]] = 1;
    }
  } catch (ignore) {}
  return out;
}

/** A "<code>: " prefix is a tag only for a known code — titles contain colons of their own. */
function courseOf_(raw, known) {
  var m = /^([^\s:]{1,24}):\s*/.exec(raw);
  if (m && (known[m[1]] || /^\d{2}-\d{3}$/.test(m[1]))) return m;
  return null;
}

/**
 * The page is two halves: #live, which goes stale and pageRefresh re-renders, and everything around
 * it - the rail's payload, the parser, the add bar - served once. A failed render costs only #live,
 * so the error page still carries the key and recovers on its next refresh.
 */
function pageHtml_(now, key) {
  var p;
  try {
    p = pageData_(now);
  } catch (err) {
    p = { html: '<p class="none">' + esc_(String((err && err.message) || err)) + ' &middot; <a href="#" onclick="refresh(this);return false">refresh</a></p>', day: null };
  }
  // Rendered by the client from this payload; < keeps a hostile title from closing the tag. KEY is
  // the one doGet has just checked, handed back so a refresh can present it again.
  return shell_('<div id="live">' + p.html + '</div>' +
    '<script>var DAY = ' + JSON.stringify(p.day).replace(/</g, '\\u003c') +
    ', KEY = ' + JSON.stringify(String(key)).replace(/</g, '\\u003c') + ';</script>' +
    '<script>' + PARSER_JS_ + '</script>' + addTodoForm_());
}

function pageData_(now) {
  var tz = Session.getScriptTimeZone();
  var today = dayKey_(now, tz);
  var horizon = dayKey_(new Date(now.getTime() + PAGE_DAYS * 86400000), tz);

  var events = CalendarApp.getDefaultCalendar().getEvents(
    new Date(now.getTime() - BACK_DAYS * 86400000),
    new Date(now.getTime() + (PAGE_DAYS + 1) * 86400000)
  );
  events.sort(byStart_);

  var re = new RegExp(MARKER + ' id=(\\S+)');
  var overdue = [];
  var dueToday = [];
  var doneToday = [];
  var week = [];
  // The rail: today's classes and timed deadlines, handed to the CLIENT as data. The phone
  // renders it and re-renders every 30 seconds, so "now" is the phone's clock, not the moment
  // the page happened to be served.
  var classesToday = [];
  var duePins = [];
  // Every space code the desktop has synced up, plus any seen on a class title in the window,
  // handed to the client so the preview parser recognises "80-100" — or "nostep" — the way the
  // desktop does. Codes double as ids for all real spaces.
  var courseCodes = knownCodes_();
  // A tick waits in the queue until Tartan next opens, and the calendar says "not done" until then.
  // Those rows render sent, or the next refresh would un-tick them in front of whoever ticked them.
  var pending = {};
  var queued = [];
  try { queued = queueLoad_().items; } catch (ignore) {}
  for (var qi = 0; qi < queued.length; qi++) pending[queued[qi].kind + ' ' + queued[qi].target] = 1;

  for (var i = 0; i < events.length; i++) {
    var ev = events[i];
    var hit = re.exec(ev.getDescription() || '');
    if (!hit) continue;
    var id = hit[1];

    if (id.indexOf('class-') === 0) {
      var t = ev.getTitle();
      var dot = t.indexOf(' · ');
      var code = dot === -1 ? t : t.slice(0, dot);
      if (code) courseCodes[code] = 1;
      if (dayKey_(ev.getStartTime(), tz) === today) {
        classesToday.push({
          code: code,
          room: ev.getLocation() || '',
          s: minsOf_(ev.getStartTime(), tz),
          e: minsOf_(ev.getEndTime(), tz)
        });
      }
      continue;
    }

    var raw = ev.getTitle();
    var isDone = raw.indexOf('✓ ') === 0;
    if (isDone) raw = raw.slice(2);

    var start = ev.getStartTime();
    var on = dayKey_(start, tz);
    if (on > horizon) continue;
    // Done work only matters on TODAY'S page — struck rows and the progress line are the "you
    // are actually moving" half. Past or future done rows are clutter, exactly as before.
    if (isDone && on !== today) continue;

    var course = '';
    var m = courseOf_(raw, courseCodes);
    if (m) {
      course = m[1];
      raw = raw.slice(m[0].length);
      courseCodes[course] = 1;
    }
    var done = isDone || !!pending['deadline.done ' + id];
    var item = {
      id: id,
      course: course,
      title: raw,
      done: done,
      at: ev.isAllDayEvent() ? '' : clock_(start, tz)
    };

    if (on < today) overdue.push(item);
    else if (on === today) {
      if (!ev.isAllDayEvent()) duePins.push({ m: minsOf_(start, tz), course: course, title: raw, done: done });
      // Filed by the CALENDAR's state, drawn by the queue's. A queued tick that sank to the bottom
      // on the next background refresh slid every row below it up under a thumb already on its way
      // to the next tick, and a phone tick cannot be taken back.
      (isDone ? doneToday : dueToday).push(item);
    } else bucket_(week, on, dayName_(start, tz)).items.push(item);
  }

  // Other calendars kept ticked in Google Calendar — the linked andrew account, a club — give the
  // rail today's timed events. The primary is skipped (Tartan's own rows live there and arrive
  // through the marker scan above), and an event sharing a class's start minute is that class seen
  // through a second calendar, dropped rather than shown twice. Capped so one runaway shared
  // calendar cannot flood the page.
  var extras = [];
  try {
    // The scan walks every ticked calendar and costs 2–3 s of CalendarApp time — cached for five
    // minutes so a phone refresh is not paying it again. Key includes the day so midnight rolls.
    var cache = CacheService.getScriptCache();
    var cacheKey = 'evs-' + today;
    var hit = cache.get(cacheKey);
    if (hit !== null) {
      extras = JSON.parse(hit);
    } else {
      var dayStart = dateOnly(today);
      var dayEnd = new Date(dayStart.getTime() + 86400000);
      var classStarts = {};
      for (var cs = 0; cs < classesToday.length; cs++) classStarts[classesToday[cs].s] = 1;
      var cals = CalendarApp.getAllCalendars();
      for (var ci = 0; ci < cals.length && extras.length < 20; ci++) {
        if (cals[ci].isMyPrimaryCalendar() || !cals[ci].isSelected() || cals[ci].isHidden()) continue;
        var todayEvs = cals[ci].getEvents(dayStart, dayEnd);
        for (var ti = 0; ti < todayEvs.length && extras.length < 20; ti++) {
          var te = todayEvs[ti];
          if (te.isAllDayEvent() || dayKey_(te.getStartTime(), tz) !== today) continue;
          var ts = minsOf_(te.getStartTime(), tz);
          if (classStarts[ts]) continue;
          extras.push({
            title: te.getTitle() || 'busy',
            room: te.getLocation() || '',
            s: ts,
            e: Math.max(ts + 1, minsOf_(te.getEndTime(), tz))
          });
        }
      }
      cache.put(cacheKey, JSON.stringify(extras), 300);
    }
  } catch (ignore) {}

  var doneCount = doneToday.length;
  for (var dc = 0; dc < dueToday.length; dc++) if (dueToday[dc].done) doneCount++;
  var totalToday = doneToday.length + dueToday.length;

  var h = [];
  h.push('<header><h1>' + esc_(dayName_(now, tz)) + '</h1><p class="sub" id="clk">' + esc_(clock_(now, tz)) +
    (totalToday ? ' &middot; ' + doneCount + ' of ' + totalToday + ' done' : '') +
    ' &middot; <a href="#" onclick="refresh(this);return false">refresh</a></p>' +
    (totalToday ? '<div class="progress"><i style="width:' + Math.round((doneCount / totalToday) * 100) + '%"></i></div>' : '') +
    '</header>');

  h.push('<section class="railcard"><div id="rail"></div></section>');

  if (overdue.length) {
    h.push('<section><h2>Overdue</h2>' + rows_(overdue, 'late', 'deadline.done') + '</section>');
  }

  h.push('<section><h2>Due today</h2>' +
    (dueToday.length || doneToday.length
      ? rows_(dueToday.concat(doneToday), '', 'deadline.done')
      : '<p class="none">Nothing due today.</p>') +
    '</section>');

  var wk = ['<section><h2>This week</h2>'];
  if (!week.length) wk.push('<p class="none">Nothing due in the next ' + PAGE_DAYS + ' days.</p>');
  for (var g = 0; g < week.length; g++) {
    wk.push('<h3>' + esc_(week[g].label) + '</h3>' + rows_(week[g].items, '', 'deadline.done'));
  }
  h.push(wk.join('') + '</section>');

  // Tasks is the optional half of the sync and must never take the page down with it.
  var todos;
  try {
    todos = openTodos_(courseCodes);
  } catch (err) {
    todos = null;
  }
  for (var tj = 0; todos && tj < todos.length; tj++) todos[tj].done = !!pending['todo.done ' + todos[tj].id];
  h.push('<section><h2>Todos</h2>' + (
    todos === null ? '<p class="none">Google Tasks is not connected.</p>'
      : todos.length ? rows_(todos, '', 'todo.done')
      : '<p class="none">Nothing on the list.</p>'
  ) + '</section>');

  var codes = [];
  for (var ck in courseCodes) codes.push({ id: ck, code: ck });
  return { html: h.join(''), day: { classes: classesToday, pins: duePins, courses: codes, evs: extras } };
}

/** Open todos from the Tartan list. Never creates the list: loading a page must not write. */
function openTodos_(known) {
  if (typeof Tasks === 'undefined' || !Tasks.Tasklists) return null;

  var lists = Tasks.Tasklists.list({ maxResults: 100 }).items || [];
  var listId = null;
  for (var i = 0; i < lists.length; i++) if (lists[i].title === 'Tartan') listId = lists[i].id;
  if (!listId) return [];

  var out = [];
  var token = null;
  do {
    var page = Tasks.Tasks.list(listId, { maxResults: 100, showCompleted: false, pageToken: token });
    var items = page.items || [];
    for (var j = 0; j < items.length; j++) {
      if (items[j].status === 'completed') continue;
      var title = items[j].title || '';
      var course = '';
      var m = courseOf_(title, known || {});
      if (m) {
        course = m[1];
        title = title.slice(m[0].length);
      }
      // The task's own notes carry the Tartan id, same marker as the calendar.
      var idm = new RegExp(MARKER + ' id=(\\S+)').exec(items[j].notes || '');
      out.push({
        id: idm ? idm[1] : '',
        course: course,
        title: title,
        at: String(items[j].due || '').slice(5, 10)
      });
    }
    token = page.nextPageToken;
  } while (token);
  return out;
}

/**
 * A row, with its tick control. The control is the only thing on this page that writes, and the
 * only verb it has is done=true — the page cannot un-tick, delete or edit anything, which is what
 * makes a redelivered action a no-op instead of a merge problem.
 */
function rows_(items, cls, kind) {
  var out = ['<ul>'];
  for (var i = 0; i < items.length; i++) {
    var it = items[i];
    // A done row renders in the sent state it would have reached anyway — struck through, green
    // tick, no control. The tick verb is monotone, so there is deliberately nothing to press.
    out.push('<li class="' + (it.done ? 'sent ' : '') + cls + '">' +
      (it.done
        ? '<span class="tick"></span>'
        : it.id
          ? '<button class="tick" aria-label="Mark done" onclick="tick(this,\'' + kind + '\',' +
            esc_(JSON.stringify(String(it.id))) + ')"></button>'
          : '<span class="tick ghost"></span>') +
      (it.course ? '<span class="tag">' + esc_(it.course) + '</span>' : '') +
      '<span class="what">' + esc_(it.title) + '</span>' +
      (it.at ? '<span class="when">' + esc_(it.at) + '</span>' : '') +
      '</li>');
  }
  return out.join('') + '</ul>';
}

/**
 * The capture bar, Google-Calendar simple: type a name, tap 📅 for native date/time pickers, a
 * repeat choice and a course — no syntax to learn. The pickers COMPOSE a plain text line and the
 * pill previews it through the desktop's own parser, so what you see is literally what Tartan
 * will do. Typed syntax ("pset friday 5pm") still works in the same box for anyone who wants it,
 * and the wire stays exactly one verb: todo.add with a text.
 */
function addTodoForm_() {
  return '<form class="add" onsubmit="return addTodo(this)">' +
    '<p id="pv" class="pv"></p>' +
    '<div id="opts" class="opts" style="display:none">' +
    '<select id="o-course" aria-label="Course"><option value="">Course</option></select>' +
    '<input id="o-date" type="date" aria-label="Date">' +
    '<input id="o-time" type="time" aria-label="Time">' +
    '<select id="o-rep" aria-label="Repeat">' +
    '<option value="">No repeat</option>' +
    '<option value="day">Every day</option>' +
    '<option value="week">Weekly…</option>' +
    '</select>' +
    '</div>' +
    '<div id="days" class="days" style="display:none">' +
    '<button type="button" class="day" data-d="mon">M</button>' +
    '<button type="button" class="day" data-d="tue">T</button>' +
    '<button type="button" class="day" data-d="wed">W</button>' +
    '<button type="button" class="day" data-d="thu">T</button>' +
    '<button type="button" class="day" data-d="fri">F</button>' +
    '<button type="button" class="day" data-d="sat">S</button>' +
    '<button type="button" class="day" data-d="sun">S</button>' +
    '</div>' +
    '<div class="addrow">' +
    '<button type="button" id="o-toggle" class="tune" aria-label="Date, time and repeat options" aria-expanded="false">📅</button>' +
    '<input name="text" placeholder="Add…" autocomplete="off" maxlength="200">' +
    '<button type="submit">Add</button>' +
    '</div>' +
    '</form>';
}

function shell_(inner) {
  return '<style>' +
    ':root{color-scheme:dark light;--bg:#111214;--card:#191b1f;--fg:#f2f3f5;--dim:#9aa0a6;--line:#2a2d33;' +
    '--hot:#ff6b5e;--ok:#3ba55d;--acc:#d23852}' +
    '@media(prefers-color-scheme:light){:root{--bg:#fbfbfc;--card:#fff;--fg:#16181c;--dim:#63676e;--line:#e4e6ea}}' +
    '*{box-sizing:border-box}html,body{margin:0;background:var(--bg);color:var(--fg)}' +
    'body{font:16px/1.45 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;' +
    // The safe-area insets are what keep the page out of the notch and above the home bar when
    // it runs full screen from the home screen.
    'padding:calc(16px + env(safe-area-inset-top)) 14px calc(96px + env(safe-area-inset-bottom));' +
    'max-width:34rem;margin:0 auto;-webkit-text-size-adjust:100%}' +
    'h1{font-size:1.65rem;font-weight:700;letter-spacing:-.015em;margin:0}' +
    // Sections are cards, Things-style; their headers stay put while the card scrolls under.
    'section{background:var(--card);border:1px solid var(--line);border-radius:14px;' +
    'padding:2px 14px 12px;margin-top:14px}' +
    'h2{font-size:.72rem;letter-spacing:.09em;text-transform:uppercase;color:var(--dim);' +
    'position:sticky;top:0;background:var(--card);margin:0 -14px;padding:12px 14px 6px;' +
    'border-radius:14px 14px 0 0;z-index:2}' +
    'h3{font-size:.85rem;font-weight:600;color:var(--dim);margin:12px 0 2px}' +
    'a{color:inherit}.sub,.none{color:var(--dim);margin:4px 0 0}' +
    '.progress{height:4px;background:var(--line);border-radius:2px;margin-top:10px;overflow:hidden}' +
    '.progress i{display:block;height:100%;background:var(--ok);border-radius:2px}' +
    '.railcard{padding-top:8px;padding-bottom:8px}' +
    '.rl{display:grid;grid-template-columns:64px 12px minmax(0,1fr);gap:0 10px;align-items:baseline;padding:6px 0}' +
    '.rl .t{font-size:.8rem;color:var(--dim);text-align:right;font-variant-numeric:tabular-nums;white-space:nowrap}' +
    '.rl .sp{position:relative;align-self:stretch}' +
    '.rl .sp::before{content:"";position:absolute;left:4px;top:-6px;bottom:-6px;width:2px;background:var(--line)}' +
    '.rl .sp i{position:absolute;left:1px;top:50%;margin-top:-4px;width:8px;height:8px;border-radius:50%;background:var(--dim)}' +
    '.rl.d .sp i{left:2px;margin-top:-3px;width:6px;height:6px;border-radius:2px}' +
    '.rl .sp i.o{background:transparent;border:2px solid var(--dim);box-sizing:border-box}' +
    '.rl .b{display:flex;gap:8px;align-items:baseline;min-width:0}' +
    '.rl .b b{font-weight:650}' +
    '.rl .b .dim{color:var(--dim);font-size:.85rem}' +
    '.rl .w{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}' +
    '.rl.past{opacity:.4}' +
    '.rl.cur{background:color-mix(in srgb,var(--acc) 13%,transparent);box-shadow:inset 3px 0 0 var(--acc);border-radius:8px}' +
    '.rl.late .w,.rl.late .t{color:var(--hot)}' +
    '.rl.done .w{text-decoration:line-through;opacity:.6}' +
    '.rl.g .b{font-size:.85rem}' +
    '.rl.now{align-items:center;padding:2px 0}' +
    '.rl.now .t{color:var(--acc);font-size:.72rem}' +
    '.rl.now .ln{grid-column:2/4;height:2px;background:var(--acc);border-radius:1px}' +
    'ul{list-style:none;margin:0;padding:0}' +
    'li{display:flex;gap:10px;align-items:baseline;padding:12px 0;border-bottom:1px solid var(--line)}' +
    'li:last-child{border-bottom:0}' +
    'li.sent{opacity:.45}li.sent .what{text-decoration:line-through}' +
    '.tick{flex:none;width:26px;height:26px;border:1.5px solid var(--dim);border-radius:7px;' +
    'background:none;padding:0;cursor:pointer;align-self:center}' +
    '.tick:disabled{opacity:.4}.tick.ghost{border-style:dashed;opacity:.4}' +
    'li.sent .tick{background:var(--ok);border-color:var(--ok)}' +
    '.tag{flex:none;font-size:.78rem;color:var(--dim);font-variant-numeric:tabular-nums}' +
    // Course chips take a hue hashed from the code — the Notion block recipe from the desktop:
    // a whisper of fill plus a solid bar, never a saturated slab. paint() sets --h per chip.
    '.tag.c{color:hsl(var(--h),55%,72%);background:hsla(var(--h),55%,55%,.14);' +
    'border-left:3px solid hsl(var(--h),55%,55%);padding:1px 6px;border-radius:4px}' +
    '@media(prefers-color-scheme:light){.tag.c{color:hsl(var(--h),55%,32%);background:hsla(var(--h),55%,45%,.12)}}' +
    '.what{flex:1;min-width:0}' +
    '.when{flex:none;font-size:.82rem;color:var(--dim);font-variant-numeric:tabular-nums}' +
    '.late .tag,.late .what,.late .when{color:var(--hot)}' +
    // The capture bar rides the bottom of the screen, TickTick-style: between-class capture is
    // one thumb, wherever the page happens to be scrolled. The body's bottom padding clears it.
    '.add{position:fixed;left:50%;transform:translateX(-50%);z-index:5;' +
    'bottom:calc(10px + env(safe-area-inset-bottom));width:calc(100% - 24px);max-width:calc(34rem - 24px);' +
    'display:flex;flex-direction:column;gap:6px;align-items:flex-start}' +
    '.addrow{display:flex;gap:8px;width:100%;box-shadow:0 8px 24px rgba(0,0,0,.45);border-radius:12px}' +
    // Scoped to the row: .add now contains pickers and day-chip BUTTONS that must not inherit
    // the accent submit styling — unscoped ".add button" painted all seven chips red at once.
    '.addrow input{flex:1;min-width:0;padding:12px;border:1px solid var(--line);border-radius:10px;' +
    'background:var(--card);color:var(--fg);font:inherit}' +
    '.addrow button[type=submit]{flex:none;padding:12px 18px;border:0;border-radius:10px;background:var(--acc);' +
    'color:#fff;font:inherit;font-weight:600}' +
    '.pv{display:none;margin:0;font-size:.78rem;color:var(--fg);background:var(--card);' +
    'border:1px solid var(--line);border-radius:99px;padding:5px 12px;box-shadow:0 6px 18px rgba(0,0,0,.4)}' +
    '.opts{display:flex;gap:6px;width:100%}' +
    '.opts select,.opts input{flex:1;min-width:0;padding:9px 8px;border:1px solid var(--line);' +
    'border-radius:10px;background:var(--card);color:var(--fg);font:inherit;font-size:.85rem}' +
    '.days{display:flex;gap:8px}' +
    '.day{width:34px;height:34px;border-radius:50%;border:1px solid var(--line);background:var(--card);' +
    'color:var(--dim);font:inherit;font-size:.8rem;padding:0}' +
    '.day.on{background:var(--acc);border-color:var(--acc);color:#fff;font-weight:600}' +
    '.tune{flex:none;width:47px;border:1px solid var(--line);border-radius:10px;background:var(--card);' +
    'font-size:1.05rem;padding:0}' +
    '.tune.on{border-color:var(--acc)}' +
    '#say{position:fixed;left:0;right:0;bottom:calc(64px + env(safe-area-inset-bottom));' +
    'padding:11px 16px;background:var(--card);border-top:1px solid var(--line);color:var(--dim);display:none}' +
    '</style>' +
    inner +
    '<div id="say"></div>' +
    '<script>' +
    'function say(m){var s=document.getElementById("say");s.textContent=m;s.style.display="block";' +
    'clearTimeout(window._t);window._t=setTimeout(function(){s.style.display="none"},4000)}' +
    // google.script.run gives a real success/failure callback, which a cross-origin fetch to an
    // Apps Script endpoint cannot. The control is disabled while in flight so a double tap
    // cannot queue twice.
    'function tick(b,kind,target){b.disabled=true;tg++;' +
    'google.script.run.withSuccessHandler(function(){tg++;b.closest("li").classList.add("sent");if(!document.body.contains(b))refresh();' +
    'say("Saved. It will appear in Tartan when you next open it.")})' +
    '.withFailureHandler(function(e){b.disabled=false;say(e.message||"Could not save that.")})' +
    '.inboxEnqueue({kind:kind,target:target})}' +
    // What a line will become, judged by the same parseEntry the desktop applies it with (TP is
    // the bundled parser; missing only if the generated blob was stripped, and then the box still
    // works — it just stops predicting).
    'function hm12(t){var p=t.split(":");var h=+p[0];var hh=h%12===0?12:h%12;' +
    'return hh+":"+p[1]+" "+(h<12?"am":"pm")}' +
    'function fdue(due){if(/^\\d{4}-\\d{2}-\\d{2}$/.test(due)){var q=due.split("-");' +
    'return new Date(+q[0],q[1]-1,+q[2]).toLocaleDateString(undefined,{weekday:"short",month:"short",day:"numeric"})}' +
    'var dt=new Date(due);return dt.toLocaleDateString(undefined,{weekday:"short",month:"short",day:"numeric"})' +
    '+", "+dt.toLocaleTimeString(undefined,{hour:"numeric",minute:"2-digit"})}' +
    'function classify(v){if(!window.TP)return null;' +
    'var p=TP.parseEntry(v,(window.DAY&&DAY.courses)||[]);' +
    'if(p.every)return{k:"repeating rule",m:"repeats "+TP.everyLabel(p.every.days)+' +
    '(p.every.time?" at "+hm12(p.every.time):"")+(p.courseId?" · "+p.courseId:"")};' +
    'if(p.due)return{k:"deadline",m:"deadline · "+fdue(p.due)+(p.courseId?" · "+p.courseId:"")};' +
    'return{k:"todo",m:"todo"+(p.courseId?" · "+p.courseId:"")}}' +
    // The pickers and the box compose ONE plain line; the parser is the only meaning-maker.
    'function el(id){return document.getElementById(id)}' +
    'function compose(){var t=document.querySelector(".addrow input").value.trim();' +
    'var parts=[];var course=el("o-course")?el("o-course").value:"";' +
    'var date=el("o-date")?el("o-date").value:"";var time=el("o-time")?el("o-time").value:"";' +
    'var rep=el("o-rep")?el("o-rep").value:"";' +
    'if(course)parts.push(course);if(t)parts.push(t);' +
    'if(rep==="day")parts.push("every day");' +
    'else if(rep==="week"){var ds=[].map.call(document.querySelectorAll(".day.on"),' +
    'function(b){return b.getAttribute("data-d")});if(ds.length)parts.push("every "+ds.join(" "))}' +
    'else if(date){var q=date.split("-");parts.push(Number(q[1])+"/"+Number(q[2])+"/"+q[0])}' +
    'if(time)parts.push("at "+time);return parts.join(" ")}' +
    'function addTodo(f){if(!f.text.value.trim())return false;var v=compose();if(!v)return false;' +
    'var c=classify(v);f.text.disabled=true;' +
    'google.script.run.withSuccessHandler(function(){f.text.value="";f.text.disabled=false;' +
    'if(el("o-date"))el("o-date").value="";if(el("o-time"))el("o-time").value="";' +
    'if(el("o-rep"))el("o-rep").value="";' +
    'document.querySelectorAll(".day.on").forEach(function(b){b.classList.remove("on")});' +
    'if(el("days"))el("days").style.display="none";if(el("opts"))el("opts").style.display="none";' +
    'if(el("o-toggle")){el("o-toggle").classList.remove("on");el("o-toggle").setAttribute("aria-expanded","false")}' +
    'var pvEl=el("pv");if(pvEl){pvEl.style.display="none";pvEl.textContent=""}' +
    'say(c?"Added — lands as a "+c.k+" when Tartan next syncs.":"Added. It will appear in Tartan when you next open it.")})' +
    '.withFailureHandler(function(e){f.text.disabled=false;say(e.message||"Could not add that.")})' +
    '.inboxEnqueue({kind:"todo.add",text:v});return false}' +
    // ---- the rail. Rendered on the phone from DAY, so the now-line and the past/current states
    // follow the phone clock: a page served at 8am is still honest at 3pm.
    'function esc(s){return String(s).replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;")}' +
    'function fmt(m){var h=Math.floor(m/60),x=m%60,hh=h%12===0?12:h%12;' +
    'return hh+":"+(x<10?"0":"")+x+" "+(h<12?"am":"pm")}' +
    'function dur(m){var h=Math.floor(m/60),x=m%60;return h&&x?h+"h "+x+"m":h?h+"h":x+"m"}' +
    'function rail(){var el=document.getElementById("rail");if(!el||!window.DAY)return;' +
    'var n=new Date(),nm=n.getHours()*60+n.getMinutes(),items=[];' +
    'DAY.classes.forEach(function(c){items.push({t:"c",s:c.s,e:c.e,c:c})});' +
    'DAY.pins.forEach(function(p){items.push({t:"d",s:p.m,p:p})});' +
    '(DAY.evs||[]).forEach(function(v){items.push({t:"e",s:v.s,e:v.e,v:v})});' +
    // Free gaps by busy-until sweep, only the part of them that is still ahead. Calendar events
    // count as busy: a club meeting is not "2h free".
    'var cs=DAY.classes.concat(DAY.evs||[]).sort(function(a,b){return a.s-b.s}),cur=-1;' +
    'cs.forEach(function(c){if(cur>=0&&c.s-Math.max(cur,nm)>=45)items.push({t:"g",s:cur,e:c.s});' +
    'cur=Math.max(cur,c.e)});' +
    'if(cur>=0&&1380-Math.max(cur,nm)>=45)items.push({t:"g",s:cur,e:1380,ev:1});' +
    'items.sort(function(a,b){return a.s-b.s||(a.t==="g"?1:0)});' +
    'var h="",marked=false;' +
    'var nowRow="<div class=\\"rl now\\"><span class=\\"t\\">"+fmt(nm)+"</span><span class=\\"ln\\"></span></div>";' +
    'items.forEach(function(it){' +
    'if(!marked&&it.s>nm){h+=nowRow;marked=true}' +
    'if(it.t==="c"){var past=it.e<=nm,on=it.s<=nm&&nm<it.e;' +
    'h+="<div class=\\"rl c"+(past?" past":"")+(on?" cur":"")+"\\"><span class=\\"t\\">"+fmt(it.s)+"</span>"+' +
    '"<span class=\\"sp\\"><i style=\\"background:hsl("+hue(it.c.code)+",55%,60%)\\"></i></span><span class=\\"b\\"><b>"+esc(it.c.code)+"</b>"+' +
    '(it.c.room?"<span class=\\"dim\\">"+esc(it.c.room)+"</span>":"")+' +
    '(on?"<span class=\\"dim\\">until "+fmt(it.e)+" · "+(it.e-nm)+"m left</span>":"")+"</span></div>"}' +
    'else if(it.t==="d"){var late=!it.p.done&&it.s<=nm;' +
    'h+="<div class=\\"rl d"+(it.p.done?" done":"")+(late?" late":"")+"\\"><span class=\\"t\\">"+fmt(it.s)+"</span>"+' +
    '"<span class=\\"sp\\"><i></i></span><span class=\\"b\\">"+' +
    '(it.p.course?"<span class=\\"tag\\">"+esc(it.p.course)+"</span>":"")+' +
    '"<span class=\\"w\\">"+esc(it.p.title)+"</span><span class=\\"dim\\">due</span></span></div>"}' +
    'else if(it.t==="e"){var pa=it.e<=nm,cu=it.s<=nm&&nm<it.e;' +
    'h+="<div class=\\"rl e"+(pa?" past":"")+(cu?" cur":"")+"\\"><span class=\\"t\\">"+fmt(it.s)+"</span>"+' +
    '"<span class=\\"sp\\"><i class=\\"o\\" style=\\"border-color:hsl("+hue(it.v.title)+",55%,60%)\\"></i></span><span class=\\"b\\">"+' +
    '"<span class=\\"w\\">"+esc(it.v.title)+"</span>"+' +
    '(it.v.room?"<span class=\\"dim\\">"+esc(it.v.room)+"</span>":"")+' +
    '(cu?"<span class=\\"dim\\">until "+fmt(it.e)+"</span>":"")+"</span></div>"}' +
    'else{h+="<div class=\\"rl g\\"><span class=\\"t\\"></span><span class=\\"sp\\"></span>"+' +
    '"<span class=\\"b dim\\">"+dur(it.e-Math.max(it.s,nm))+" free"+(it.ev?" this evening":"")+"</span></div>"}});' +
    'if(!marked)h+=nowRow;' +
    'if(!items.length)h="<p class=\\"none\\">Nothing scheduled today.</p>";' +
    'el.innerHTML=h;paint()}' +
    // Course hues, hashed from the code so every surface agrees without a palette on the wire.
    'function hue(s){var h=0;for(var i=0;i<s.length;i++)h=(h*31+s.charCodeAt(i))%360;return h}' +
    // Every .tag the server emits is a recognised space code, so paint them all — "nostep" gets a
    // hue exactly the way "15-122" does.
    'function paint(){var tags=document.querySelectorAll(".tag");' +
    'for(var i=0;i<tags.length;i++){var x=tags[i].textContent.trim();' +
    'if(x){tags[i].classList.add("c");tags[i].style.setProperty("--h",hue(x))}}}' +
    'rail();setInterval(rail,30000);' +
    // The live preview: any change — typing or a picker — shows what the line will become.
    'var addInp=document.querySelector(".addrow input"),pvEl=document.getElementById("pv");' +
    'function refreshPv(){if(!pvEl||!addInp)return;' +
    'var c=addInp.value.trim()?classify(compose()):null;' +
    'if(!c){pvEl.style.display="none";pvEl.textContent=""}' +
    'else{pvEl.textContent="→ "+c.m;pvEl.style.display="inline-block"}}' +
    'if(addInp)addInp.addEventListener("input",refreshPv);' +
    // Fill the course picker from the day payload (again on every refresh, keeping the pick) and
    // wire the option controls once.
    'function fillCourses(){var cs=el("o-course");if(!cs||!window.DAY||!DAY.courses)return;var v=cs.value;cs.length=1;' +
    'DAY.courses.sort(function(a,b){return a.code<b.code?-1:1})' +
    '.forEach(function(c){var o=document.createElement("option");o.value=c.code;o.textContent=c.code;cs.appendChild(o)});' +
    'cs.value=v;if(cs.selectedIndex<0)cs.selectedIndex=0}' +
    'fillCourses();' +
    '(function(){var tog=el("o-toggle"),opts=el("opts"),days=el("days"),rep=el("o-rep");' +
    'if(tog&&opts)tog.addEventListener("click",function(){var open=opts.style.display!=="none";' +
    'opts.style.display=open?"none":"flex";' +
    'if(days)days.style.display=!open&&rep&&rep.value==="week"?"flex":"none";' +
    'tog.classList.toggle("on",!open);tog.setAttribute("aria-expanded",String(!open))});' +
    'if(rep)rep.addEventListener("change",function(){' +
    'if(days)days.style.display=rep.value==="week"?"flex":"none";' +
    'if(rep.value==="week"&&!document.querySelector(".day.on")){' +
    'var names=["mon","tue","wed","thu","fri","sat","sun"];' +
    'var todayName=names[(new Date().getDay()+6)%7];' +
    'var b=document.querySelector(".day[data-d="+todayName+"]");if(b)b.classList.add("on")}' +
    'refreshPv()});' +
    '["o-course","o-date","o-time"].forEach(function(id){var e=el(id);' +
    'if(e)e.addEventListener("change",refreshPv)});' +
    'document.querySelectorAll(".day").forEach(function(b){b.addEventListener("click",function(){' +
    'b.classList.toggle("on");refreshPv()})})})();' +
    // ---- refresh in place. location.reload() here reloads the sandbox iframe WITHOUT re-running
    // doGet, so it never showed anything newer than the first load. The server re-renders #live and
    // DAY instead. Ticks are inline onclick and swipe listens on document, so both work on the new
    // rows as they are; the add bar sits outside #live, so a half-typed line is never touched.
    // Everything here is bound once at load - a refresh adds no listener and no interval.
    // Any reply newer than the one on screen is painted, not only the newest request's: a tapped
    // refresh that succeeds must not be thrown away because a background one overtook it and then
    // failed. Whatever settles LAST speaks for all of them: a reply that raced a tick asks again,
    // and a failure puts back every "refreshing…" link and says why - but only once no other
    // request is still out, or a background failure would report a tap that is about to succeed
    // as failed. A background failure nobody is waiting on retries once, ten seconds later. A
    // request silent for a minute no longer counts as out.
    'function refresh(a,again){var g=tg,my=++rq;out[my]=Date.now();if(a)a.textContent="refreshing…";' +
    'google.script.run.withSuccessHandler(function(p){delete out[my];if(my<=shown)return;if(g!==tg){if(!pending())refresh(a);return}' +
    'shown=my;lastAt=Date.now();swRow=null;' +
    'el("live").innerHTML=p.html;window.DAY=p.day;fillCourses();rail();refreshPv();' +
    'if(a){var n=new Date();say("Updated "+fmt(n.getHours()*60+n.getMinutes()))}})' +
    '.withFailureHandler(function(e){delete out[my];if(pending())return;' +
    'var busy=[].filter.call(document.querySelectorAll("#live a"),function(x){return x.textContent==="refreshing…"});' +
    'busy.forEach(function(x){x.textContent="refresh"});' +
    'if(busy.length)say(e.message||"Could not refresh.");else if(!again)setTimeout(function(){stale(1)},10000)})' +
    '.pageRefresh(KEY)}' +
    'function pending(){for(var k in out)if(Date.now()-out[k]<60000)return true;return false}' +
    // A bookmark reopened the next morning must not show yesterday: coming back refreshes (at most
    // once a minute), and so does sitting open, every five. The return waits 800ms: iOS 18 is
    // reported to fail a request started in the same instant the page becomes visible.
    'function stale(again){if(!document.hidden&&Date.now()-lastAt>60000)refresh(null,again)}' +
    'var lastAt=Date.now(),tg=0,rq=0,shown=0,out={},vt=0;' +
    'document.addEventListener("visibilitychange",function(){if(!document.hidden){clearTimeout(vt);vt=setTimeout(function(){stale()},800)}});' +
    'setInterval(function(){stale()},300000);' +
    // ---- swipe-to-tick. A right swipe past ~72px presses the row's existing tick control, so
    // the wire contract is untouched: same verb, same dedupe, same monotone safety. A mostly-
    // vertical move is scrolling and cancels the gesture.
    'var swX=0,swY=0,swRow=null;' +
    'document.addEventListener("touchstart",function(e){' +
    'var li=e.target&&e.target.closest?e.target.closest("li"):null;' +
    'if(!li||li.classList.contains("sent")||!li.querySelector("button.tick"))return;' +
    'swRow=li;swX=e.touches[0].clientX;swY=e.touches[0].clientY},{passive:true});' +
    'document.addEventListener("touchmove",function(e){if(!swRow)return;' +
    'var dx=e.touches[0].clientX-swX,dy=e.touches[0].clientY-swY;' +
    'if(Math.abs(dy)>30){swRow.style.transition="transform .18s ease-out";swRow.style.transform="";swRow=null;return}' +
    'if(dx>0){swRow.style.transition="none";swRow.style.transform="translateX("+Math.min(dx,96)+"px)"}},{passive:true});' +
    'document.addEventListener("touchend",function(){if(!swRow)return;var li=swRow;swRow=null;' +
    'var m=/translateX\\((\\d+(?:\\.\\d+)?)px\\)/.exec(li.style.transform||"");var dx=m?Number(m[1]):0;' +
    'li.style.transition="transform .18s ease-out";li.style.transform="";' +
    'if(dx>=72){var b=li.querySelector("button.tick");if(b&&!b.disabled)b.click()}});' +
    '</script>';
}

/* --- page helpers, named apart from the sync helpers: `at` and `dateOnly` are already taken --- */

function dayKey_(d, tz) { return Utilities.formatDate(d, tz, 'yyyy-MM-dd'); }
function clock_(d, tz) { return Utilities.formatDate(d, tz, 'h:mm a').toLowerCase(); }
function dayName_(d, tz) { return Utilities.formatDate(d, tz, 'EEEE, MMMM d'); }
function minsOf_(d, tz) { return Number(Utilities.formatDate(d, tz, 'H')) * 60 + Number(Utilities.formatDate(d, tz, 'm')); }
function byStart_(a, b) { return a.getStartTime().getTime() - b.getStartTime().getTime(); }

function bucket_(list, key, label) {
  for (var i = 0; i < list.length; i++) if (list[i].key === key) return list[i];
  var g = { key: key, label: label, items: [] };
  list.push(g);
  return g;
}

function esc_(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

/* ------------------------------------------------------------------ inbox (phone -> Tartan) */

/**
 * Things done on the phone, waiting for Tartan to collect them.
 *
 * The laptop is usually shut, so this has to survive days. That rules CacheService out on its own:
 * its maximum TTL is six hours and persistence inside that window is not guaranteed, so a laptop
 * shut on Friday night would lose every tick by Saturday. Drive and Sheets both work but each adds
 * an OAuth scope, forcing re-authorisation AND granting an anonymously-deployed script read/write
 * over the whole Drive. Script Properties need no scope at all and this script already reads one.
 *
 * Everything the inbox knows lives in ONE value. Splitting the counter from the queue would mean
 * two setProperty calls, and an execution killed between them leaves the counter behind the queue:
 * the next tick reuses an id that has already been issued, and Tartan discards a real tick as a
 * replay. One value, one write, no divergence possible.
 */
var PROP_QUEUE = 'TARTAN_QUEUE';

/** A property VALUE is capped at 9 KB and exceeding it throws rather than truncating. */
var QUEUE_MAX_BYTES = 7000;
var QUEUE_TEXT_MAX = 200;
var QUEUE_LOCK_MS = 15000;

function queueLoad_() {
  var raw = PropertiesService.getScriptProperties().getProperty(PROP_QUEUE);
  var q = null;
  try {
    q = raw ? JSON.parse(raw) : null;
  } catch (err) {
    q = null; // a corrupt value must not brick every future tick
  }
  if (!q || !q.items) q = { seq: q && q.seq ? q.seq : 0, items: [] };
  return q;
}

/**
 * Every read-modify-write of the queue goes through here.
 *
 * doPost (Tartan acking) and google.script.run (the phone appending) are separate executions of
 * the same script and are not serialised. Without the lock, a phone tick landing during Tartan's
 * ack is lost to a stale write, silently.
 *
 * The lock wraps the QUEUE, never sync_(). A calendar pass reads an 800-day window and can run for
 * minutes; a phone tap must never sit behind that.
 */
function withQueue_(fn) {
  var lock = LockService.getScriptLock();
  lock.waitLock(QUEUE_LOCK_MS); // throws on timeout; doPost turns that into a JSON error, not a 500
  try {
    var q = queueLoad_();
    var out = fn(q);
    PropertiesService.getScriptProperties().setProperty(PROP_QUEUE, JSON.stringify(q));
    return out;
  } finally {
    if (lock.hasLock()) lock.releaseLock();
  }
}

/**
 * PUBLIC - the only function the phone page writes through, via google.script.run.
 *
 * Three verbs, all monotone: false->true, or append. Nothing here can un-tick, delete or edit, so
 * a redelivered action changes nothing by construction rather than by bookkeeping. That is the
 * whole defence of "done is mine"; the ack only stops the queue growing.
 */
function inboxEnqueue(action) {
  var kind = String((action && action.kind) || '');
  if (kind !== 'deadline.done' && kind !== 'todo.done' && kind !== 'todo.add') {
    throw new Error('Unknown action.');
  }
  var target = String((action && action.target) || '');
  var text = String((action && action.text) || '').trim().slice(0, QUEUE_TEXT_MAX);
  if (kind === 'todo.add' ? !text : !target) throw new Error('Nothing to send.');

  return withQueue_(function (q) {
    // A tick is a fact about one row, so pending ticks are a SET, not a log. Tapping the same
    // control twice collapses onto the entry already waiting instead of queueing a second one.
    if (kind !== 'todo.add') {
      for (var i = 0; i < q.items.length; i++) {
        if (q.items[i].kind === kind && q.items[i].target === target) return q.items[i].id;
      }
    }

    var entry = {
      // A monotone counter, not a timestamp: it cannot collide, cannot be replayed by a phone with
      // a wrong clock, and keeps time out of identity and ordering entirely.
      id: 'q-' + (q.seq + 1),
      kind: kind,
      // Stamped by the SERVER, the only clock both sides share. Used for display and completedAt,
      // never as an input to any decision. A timestamp sent by a client is ignored.
      at: new Date().toISOString()
    };
    if (kind === 'todo.add') {
      entry.text = text;
      if (action.course) entry.course = String(action.course).slice(0, 40);
    } else {
      entry.target = target;
    }

    // Refuse the NEW entry rather than evict an old one. An evicted entry is a tick the phone
    // already reported as saved and that nothing will ever deliver: silent, permanent and
    // unattributable. A refusal happens in front of the person who just tapped, and is
    // recoverable - open Tartan, the queue drains, tap again.
    var next = q.items.concat([entry]);
    if (JSON.stringify({ seq: q.seq + 1, items: next }).length > QUEUE_MAX_BYTES) {
      throw new Error('Phone queue is full - open Tartan to let it catch up.');
    }
    q.seq = q.seq + 1;
    q.items = next;
    return entry.id;
  });
}

/**
 * Tartan's side of the inbox. ACK FIRST, then serve what is left, so one response can never
 * re-send what that same request just acked.
 *
 * `applied` is Tartan's whole recent-applied list, not a delta. A poll whose response was lost
 * re-acks the same ids next time and the ones already gone are simply not found - self-healing,
 * with no "did that ack land" state to keep on either side.
 *
 * Serving is NOT clearing. If this response is lost in flight the actions were never applied, so
 * they must still be here next time.
 */
function inboxPoll_(applied) {
  var ack = {};
  var list = applied || [];
  for (var i = 0; i < list.length; i++) ack[String(list[i])] = true;

  return withQueue_(function (q) {
    var kept = [];
    for (var j = 0; j < q.items.length; j++) {
      if (!ack[q.items[j].id]) kept.push(q.items[j]);
    }
    var cleared = q.items.length - kept.length;
    q.items = kept;
    return { cleared: cleared, pending: kept.length, queue: kept };
  });
}
