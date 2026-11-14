import React from 'react'
import { createRoot } from 'react-dom/client'
import App from './App.jsx'
import './App.css'

// No StrictMode: its dev double-effect would run the 60 Hz physics loop twice.
createRoot(document.getElementById('root')).render(<App />)
