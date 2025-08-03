# Ezyr Backend

This is the backend API server for **Ezyr**, powering integrations with Gmail, Airtable, and Google Sheets. It handles authentication, data operations (CRUD), and serves configuration-driven UI data for the frontend.

---

## Features

- OAuth integration with Google for Gmail and Google Sheets APIs.
- Airtable API integration for database CRUD operations.
- Secure handling of client secrets and tokens.
- Config-driven architecture for flexible service management.
- RESTful endpoints supporting frontend UI interactions.

---

## Getting Started

### Prerequisites

- Node.js (v16 or higher recommended)
- npm or yarn
- Google OAuth credentials (Client ID and Secret)
- Airtable API key (if using Airtable)
- Google Spreadsheet ID (if using Sheets)

### Installation

1. Clone the repository

```bash
git clone https://github.com/AnmolSahota/ezyr-backend.git
cd ezyr-backend
