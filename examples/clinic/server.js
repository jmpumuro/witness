'use strict';
// Clinic demo app (healthcare scheduling). Edge cases exercised by Witness evals:
//  - form validation errors shown inline, then corrected (recordings contain typos and retries)
//  - unique patient email (replaying "create patient" fails with 409)
//  - patient autocomplete that listens to keyup, so locator.fill() does NOT trigger suggestions
//  - appointment slots that are consumed when booked (replay fails with 409 conflict)
//  - icon-only delete button with no accessible name (locator fallback / add a label in source)
//  - repeated "Cancel appointment" buttons and confirm() dialog
//  - dates relative to "today" (time-dependent option labels)
const { createServer, layout, json, html, escapeHtml, nextId, listen, authRoutes } = require('../_shared/mini');

const BRAND = 'Riverside Clinic';
const DOCTORS = [{ id: 1, name: 'Dr. Amara Osei' }, { id: 2, name: 'Dr. Erik Lindqvist' }];
const TIMES = ['09:00', '09:30', '10:00', '10:30', '11:00', '14:00', '14:30', '15:00'];

function isoDay(offset) {
  const d = new Date();
  d.setUTCHours(12, 0, 0, 0);
  d.setUTCDate(d.getUTCDate() + offset);
  return d.toISOString().slice(0, 10);
}

function seed() {
  return {
    users: [{ id: 1, email: 'frontdesk@clinic.test', password: process.env.CLINIC_STAFF_PASSWORD || 'desk-pass', name: 'Jo Frontdesk', role: 'staff', home: '/patients' }],
    patients: [
      { id: 1, name: 'Priya Natarajan', dob: '1988-04-12', email: 'priya.n@example.com' },
      { id: 2, name: 'Marcus Bell', dob: '1975-11-03', email: 'marcus.bell@example.com' },
      { id: 3, name: 'Priscilla Ortega', dob: '1992-07-21', email: 'p.ortega@example.com' },
      { id: 4, name: 'Tomás Reyes', dob: '2001-02-28', email: 'tomas.reyes@example.com' },
    ],
    appointments: [
      { id: 1, patientId: 2, doctorId: 1, date: isoDay(1), time: '09:00', status: 'Booked' },
      { id: 2, patientId: 4, doctorId: 2, date: isoDay(1), time: '10:00', status: 'Booked' },
    ],
  };
}

function page(ctx, title, body, script) {
  const nav = [{ href: '/patients', label: 'Patients' }, { href: '/appointments', label: 'Appointments' }, { href: '/appointments/new', label: 'Book appointment' }];
  return html(ctx.res, 200, layout({ title, brand: BRAND, nav, user: ctx.user, body, script }));
}

function validatePatient(state, body, existingId) {
  const errors = {};
  const name = String(body.name || '').trim();
  const dob = String(body.dob || '').trim();
  const email = String(body.email || '').trim().toLowerCase();
  if (!name) errors.name = 'Name is required';
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dob)) errors.dob = 'Date of birth is required';
  else if (new Date(dob + 'T00:00:00Z') > new Date()) errors.dob = 'Date of birth cannot be in the future';
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) errors.email = 'Enter a valid email address';
  if (Object.keys(errors).length) return { status: 400, errors };
  if (state.patients.some((p) => p.email === email && p.id !== existingId)) {
    return { status: 409, errors: { email: 'A patient with this email already exists' } };
  }
  return { value: { name, dob, email } };
}

function slotsFor(state, doctorId, date) {
  return TIMES.map((time) => ({
    time,
    available: !state.appointments.some((a) => a.doctorId === doctorId && a.date === date && a.time === time && a.status === 'Booked'),
  }));
}

// ---------- pages ----------

function patientsPage(ctx) {
  return page(ctx, 'Patients', `
<div style="display:flex;align-items:center;gap:12px"><h1 style="margin-right:auto">Patients</h1><a href="/patients/new"><button class="primary">New patient</button></a></div>
<table aria-label="Patients"><thead><tr><th>Name</th><th>Date of birth</th><th>Email</th><th></th></tr></thead><tbody id="rows"></tbody></table>`, `
async function load() {
  const r = await api('GET', '/api/patients');
  document.getElementById('rows').innerHTML = r.data.patients.map(p => '<tr><td><a href="/patients/' + p.id + '">' + esc(p.name) + '</a></td><td>' + p.dob + '</td><td>' + esc(p.email) + '</td>'
    + '<td><button class="icon-delete" data-id="' + p.id + '" data-name="' + esc(p.name) + '">\\u{1F5D1}</button></td></tr>').join('');
}
document.getElementById('rows').addEventListener('click', async (e) => {
  const b = e.target.closest('button.icon-delete'); if (!b) return;
  if (!confirm('Delete patient ' + b.dataset.name + '?')) return;
  const r = await api('DELETE', '/api/patients/' + b.dataset.id);
  toast(r.ok ? 'Patient deleted' : r.data.error, 0); load();
});
load();`);
}

function newPatientPage(ctx) {
  return page(ctx, 'New patient', `
<h1>New patient</h1>
<form id="f" class="card" novalidate>
  <label for="name">Full name</label><input id="name" style="width:100%"><p class="field-error" id="err-name" role="alert"></p>
  <label for="dob">Date of birth</label><input id="dob" type="date"><p class="field-error" id="err-dob" role="alert"></p>
  <label for="email">Email</label><input id="email" type="email" style="width:100%"><p class="field-error" id="err-email" role="alert"></p>
  <button class="primary" type="submit">Save patient</button>
</form>`, `
document.getElementById('f').addEventListener('submit', async (e) => {
  e.preventDefault();
  ['name','dob','email'].forEach(k => document.getElementById('err-' + k).textContent = '');
  // Read fields by id: a bare global like "name" resolves to window.name, not the input.
  const field = (id) => document.getElementById(id).value;
  const r = await api('POST', '/api/patients', { name: field('name'), dob: field('dob'), email: field('email') });
  if (!r.ok) { for (const [k, v] of Object.entries(r.data.errors || {})) document.getElementById('err-' + k).textContent = v; return; }
  location.href = '/patients/' + r.data.id + '?created=1';
});`);
}

function patientPage(ctx) {
  const p = ctx.state.patients.find((x) => x.id === Number(ctx.params.id));
  if (!p) return html(ctx.res, 404, '<h1>Patient not found</h1>');
  const appts = ctx.state.appointments.filter((a) => a.patientId === p.id);
  return page(ctx, p.name, `
<h1>Patient record for ${escapeHtml(p.name)}</h1>
<dl class="card"><dt>Date of birth</dt><dd>${p.dob}</dd><dt>Email</dt><dd>${escapeHtml(p.email)}</dd><dt>Patient ID</dt><dd>P-${String(p.id).padStart(5, '0')}</dd></dl>
<h2>Appointments</h2>
<p>${appts.length ? appts.length + ' appointment(s)' : 'No appointments yet'}</p>`, `
if (new URLSearchParams(location.search).get('created')) toast('Patient created', 0);`);
}

function appointmentsPage(ctx) {
  return page(ctx, 'Appointments', `
<h1>Appointments</h1>
<table aria-label="Appointments"><thead><tr><th>Patient</th><th>Doctor</th><th>Date</th><th>Time</th><th>Status</th><th></th></tr></thead><tbody id="rows"></tbody></table>`, `
async function load() {
  const r = await api('GET', '/api/appointments');
  document.getElementById('rows').innerHTML = r.data.appointments.map(a => '<tr><td>' + esc(a.patientName) + '</td><td>' + esc(a.doctorName) + '</td><td>' + a.date + '</td><td>' + a.time + '</td><td>' + a.status + '</td><td>'
    + (a.status === 'Booked' ? '<button data-cancel="' + a.id + '">Cancel appointment</button>' : '') + '</td></tr>').join('');
}
document.getElementById('rows').addEventListener('click', async (e) => {
  const id = e.target.dataset.cancel; if (!id) return;
  if (!confirm('Cancel this appointment?')) return;
  const r = await api('POST', '/api/appointments/' + id + '/cancel');
  toast(r.ok ? 'Appointment cancelled' : r.data.error, 0); load();
});
load();
if (new URLSearchParams(location.search).get('booked')) toast('Appointment booked', 0);`);
}

function bookPage(ctx) {
  const days = [1, 2, 3, 4, 5].map(isoDay);
  return page(ctx, 'Book appointment', `
<h1>Book appointment</h1>
<form id="f" class="card" novalidate autocomplete="off">
  <label for="patient">Patient</label>
  <div style="position:relative;max-width:420px">
    <input id="patient" role="combobox" aria-autocomplete="list" aria-expanded="false" aria-controls="patient-options" style="width:100%">
    <ul id="patient-options" role="listbox" aria-label="Matching patients" hidden style="position:absolute;left:0;right:0;background:#fff;border:1px solid #d3d1c7;list-style:none;margin:2px 0;padding:0;z-index:5"></ul>
  </div>
  <input type="hidden" id="patient-id">
  <label for="doctor">Doctor</label>
  <select id="doctor"><option value="">Choose a doctor</option>${DOCTORS.map((d) => `<option value="${d.id}">${escapeHtml(d.name)}</option>`).join('')}</select>
  <label for="date">Date</label>
  <select id="date">${days.map((d) => `<option value="${d}">${new Date(d + 'T12:00:00Z').toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric', timeZone: 'UTC' })}</option>`).join('')}</select>
  <label for="time">Time</label>
  <select id="time" disabled><option value="">Choose a doctor first</option></select>
  <p class="field-error" id="err" role="alert"></p>
  <button class="primary" type="submit">Book appointment</button>
</form>`, `
const input = document.getElementById('patient'), list = document.getElementById('patient-options');
let timer;
// NOTE: listens to keyup (like many legacy widgets) — a programmatic fill() won't open suggestions.
input.addEventListener('keyup', () => {
  clearTimeout(timer);
  document.getElementById('patient-id').value = '';
  timer = setTimeout(async () => {
    const q = input.value.trim();
    if (q.length < 2) { list.hidden = true; input.setAttribute('aria-expanded', 'false'); return; }
    const r = await api('GET', '/api/patients?q=' + encodeURIComponent(q));
    list.innerHTML = r.data.patients.map(p => '<li role="option" data-id="' + p.id + '" style="padding:6px 10px;cursor:pointer">' + esc(p.name) + ' · ' + p.dob + '</li>').join('') || '<li class="muted" style="padding:6px 10px">No matches</li>';
    list.hidden = false; input.setAttribute('aria-expanded', 'true');
  }, 250);
});
list.addEventListener('click', (e) => {
  const li = e.target.closest('[role=option]'); if (!li) return;
  input.value = li.textContent.split(' · ')[0];
  document.getElementById('patient-id').value = li.dataset.id;
  list.hidden = true; input.setAttribute('aria-expanded', 'false');
});
async function loadSlots() {
  const doctor = document.getElementById('doctor').value, date = document.getElementById('date').value, sel = document.getElementById('time');
  if (!doctor) { sel.disabled = true; sel.innerHTML = '<option value="">Choose a doctor first</option>'; return; }
  const r = await api('GET', '/api/slots?doctorId=' + doctor + '&date=' + date);
  sel.innerHTML = '<option value="">Choose a time</option>' + r.data.slots.map(s => '<option value="' + s.time + '"' + (s.available ? '' : ' disabled') + '>' + s.time + (s.available ? '' : ' (booked)') + '</option>').join('');
  sel.disabled = false;
}
document.getElementById('doctor').addEventListener('change', loadSlots);
document.getElementById('date').addEventListener('change', loadSlots);
document.getElementById('f').addEventListener('submit', async (e) => {
  e.preventDefault();
  const err = document.getElementById('err'); err.textContent = '';
  const body = { patientId: Number(document.getElementById('patient-id').value), doctorId: Number(document.getElementById('doctor').value), date: document.getElementById('date').value, time: document.getElementById('time').value };
  const r = await api('POST', '/api/appointments', body);
  if (!r.ok) { err.textContent = r.data.error; if (r.status === 409) loadSlots(); return; }
  location.href = '/appointments?booked=1';
});`);
}

// ---------- routes ----------

const server = createServer({
  name: BRAND,
  seed,
  routes: [
    ...authRoutes({ brand: BRAND, home: '/patients' }),
    ['GET', '/', (ctx) => { ctx.res.writeHead(302, { location: '/patients' }); ctx.res.end(); }, { auth: true }],
    ['GET', '/patients', patientsPage, { auth: true }],
    ['GET', '/patients/new', newPatientPage, { auth: true }],
    ['GET', '/patients/:id', patientPage, { auth: true }],
    ['GET', '/appointments', appointmentsPage, { auth: true }],
    ['GET', '/appointments/new', bookPage, { auth: true }],

    ['GET', '/api/patients', (ctx) => {
      const q = String(ctx.query.q || '').toLowerCase();
      return json(ctx.res, 200, { patients: ctx.state.patients.filter((p) => p.name.toLowerCase().includes(q)) });
    }, { auth: true }],
    ['POST', '/api/patients', (ctx) => {
      const v = validatePatient(ctx.state, ctx.body);
      if (v.errors) return json(ctx.res, v.status, { errors: v.errors });
      const p = { id: nextId(ctx.state.patients), ...v.value };
      ctx.state.patients.push(p);
      return json(ctx.res, 201, p);
    }, { auth: true }],
    ['DELETE', '/api/patients/:id', (ctx) => {
      const id = Number(ctx.params.id);
      if (ctx.state.appointments.some((a) => a.patientId === id && a.status === 'Booked')) {
        return json(ctx.res, 409, { error: 'Cancel this patient’s appointments first' });
      }
      const i = ctx.state.patients.findIndex((p) => p.id === id);
      if (i < 0) return json(ctx.res, 404, { error: 'Patient not found' });
      ctx.state.patients.splice(i, 1);
      return json(ctx.res, 200, { ok: true });
    }, { auth: true }],

    ['GET', '/api/slots', (ctx) => json(ctx.res, 200, { slots: slotsFor(ctx.state, Number(ctx.query.doctorId), String(ctx.query.date)) }), { auth: true }],
    ['GET', '/api/appointments', (ctx) => json(ctx.res, 200, {
      appointments: ctx.state.appointments.map((a) => ({
        ...a,
        patientName: (ctx.state.patients.find((p) => p.id === a.patientId) || {}).name || 'Unknown',
        doctorName: (DOCTORS.find((d) => d.id === a.doctorId) || {}).name,
      })),
    }), { auth: true }],
    ['POST', '/api/appointments', (ctx) => {
      const { patientId, doctorId, date, time } = ctx.body;
      if (!ctx.state.patients.some((p) => p.id === patientId)) return json(ctx.res, 400, { error: 'Choose a patient from the list' });
      if (!DOCTORS.some((d) => d.id === doctorId)) return json(ctx.res, 400, { error: 'Choose a doctor' });
      if (!TIMES.includes(time)) return json(ctx.res, 400, { error: 'Choose a time' });
      const taken = !slotsFor(ctx.state, doctorId, date).find((s) => s.time === time).available;
      if (taken) return json(ctx.res, 409, { error: 'That slot was just booked. Choose another time.' });
      const a = { id: nextId(ctx.state.appointments), patientId, doctorId, date, time, status: 'Booked' };
      ctx.state.appointments.push(a);
      return json(ctx.res, 201, a);
    }, { auth: true }],
    ['POST', '/api/appointments/:id/cancel', (ctx) => {
      const a = ctx.state.appointments.find((x) => x.id === Number(ctx.params.id));
      if (!a) return json(ctx.res, 404, { error: 'Appointment not found' });
      if (a.status !== 'Booked') return json(ctx.res, 409, { error: 'Appointment is not active' });
      a.status = 'Cancelled';
      return json(ctx.res, 200, a);
    }, { auth: true }],
  ],
});

listen(server, 4102, BRAND);
