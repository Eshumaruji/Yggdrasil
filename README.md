# LifeFlow: Blood Donation Management Platform

A web platform that connects **donors**, **blood banks** and **requestors** (clinics and hospitals), so blood reaches the people who need it faster.

## Contents

- [User roles](#user-roles)
- [Donor features](#donor-features)
- [Blood bank features](#blood-bank-features)
- [Requestor features](#requestor-features)
- [Points system](#points-system)
- [Themes](#themes)
- [Project structure](#project-structure)
- [Open questions](#open-questions)

## User roles

| Role | Who they are | What they do |
|------|--------------|--------------|
| **Donor** | Individuals aged 18+ | Donate blood, join camps, respond to emergencies, earn points |
| **Blood bank** | Registered organisations | Manage donors, host camps, request and track donations |
| **Requestor** | Clinics and hospitals | Request blood with delivery or pickup |

---

## Donor features

### Registration

- [ ] Personal details, location and blood type
- [ ] Age check: must be **18 or older**
- [ ] Health declaration: **no HIV/AIDS**
- [ ] Rare blood type detection (see [Rare donors](#rare-donors))
- [ ] Short intro guide with video links (**skippable**)

#### Rare donors

If the donor's blood type is rare, they see a congratulations screen:

> You're a **shiny Pokémon!** Your blood can save a ton of people.

Rare donors get:

- A **shiny (gold) dashboard** for their whole account
- **5x points boost** on every activity

### Guide

- [ ] Video links on how blood donation works
- [ ] Emergency request guide: what to do when an alert arrives

### Dashboard

- [ ] Request to join blood banks, with **recommendations based on region**
- [ ] Book donation appointments
- [ ] Points, badges and donation history

### Community

| Feature | Details |
|---------|---------|
| **Posts** | Like, comment, share and report |
| **Blood donation camps** | Register for an event, scan a QR code on arrival, scan again when done, earn **community service points** |
| **Leaderboard** | Rankings such as "Holy Donors" |

### Emergency alerts

- [ ] Blood donation notification
- [ ] Google Maps location of the request
- [ ] Estimated total time (travel and donation)
- [ ] Accept or decline the request

---

## Blood bank features

### Registration

- [ ] Organisation details and location
- [ ] Hosting donation camps: **yes / no**
- [ ] Donor mode: **public** or **private**

### Dashboard

#### Private donor list

- [ ] Add donors to the bank's own list
- [ ] If the donor uses the app, send an **app notification**
- [ ] Otherwise, send an **SMS**

#### Requesting public donors

- [ ] Notify nearby donors
- [ ] Show the number of donors who accepted
- [ ] When enough donors accept, mark the emergency as **criteria fulfilled**
- [ ] Donor and blood bank each **scan a QR code twice** (start and end) to award points
- [ ] **Two-way feedback** between donor and blood bank

#### Camp announcements

- [ ] Send camp notifications; donors register through the web app
- [ ] Donors who complete both scans have **blood bag details saved** to their record

#### Clinic and hospital requests

- [ ] View requestor details
- [ ] **Accept** (manual review) if stock and service are available
- [ ] **Reject** with a reason: blood not available, or service not available
- [ ] Map view with **distance and estimated time**

---

## Requestor features

### Registration

- [ ] Clinic or hospital details
- [ ] Location

### Dashboard

- [ ] Request blood
- [ ] Choose **delivery** or **pickup**
- [ ] Map view with **distance and estimated time**
- [ ] Track request status (pending, accepted, rejected, fulfilled)

---

## Points system

| Activity | Points |
|----------|--------|
| Donate blood | Base points |
| Attend a camp (scan in and scan out) | Community service points |
| Respond to an emergency (scan twice) | Bonus points |
| **Rare blood type** | **5x multiplier on all of the above** |

Point values are to be decided.

---

## Themes

| Theme | Used for |
|-------|----------|
| **White and blood red** | Default for all users |
| **Gold (shiny)** | Rare blood type donors (whole dashboard) |

Themes are set in `styles.css`. Use `data-theme="rare"` on the `<html>` tag for a full page, or add class `rare` to individual elements.

---

## Project structure

```
.
├── index.html     # Sample UI: header, side tabs, cards, buttons, forms
├── styles.css     # Default theme and rare donor theme
└── README.md
```

---

## Open questions

Decisions to settle before building:

- **Health declaration:** self-declared, or verified at the bank? HIV status is sensitive data and needs careful storage and consent.
- **QR scanning:** should codes be single-use or time-limited, to prevent point fraud?
- **Rare blood types:** which types count as rare (for example Bombay `hh`, Rh-null, AB-)?
- **Emergency radius:** how far should "nearby donors" extend, and does it widen over time?
- **Notifications:** which SMS and push providers will be used?
- **Maps and time estimates:** Google Maps API (paid) or an alternative?
