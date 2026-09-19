# State Management Documentation

This document describes the state management architecture implemented in the Prediction DAO frontend.

## Overview

The application uses React Context API with custom hooks to manage global and local state. This approach eliminates prop drilling and provides a clean, testable interface for state management.

## Architecture

### Contexts

#### 1. Web3Context (`src/contexts/Web3Context.jsx`)

Manages all Web3-related state including:
- Wallet connection (account, isConnected)
- Network information (chainId, networkError)
- Provider and signer instances
- Connection actions (connectWallet, disconnectWallet, switchNetwork)

**Provider Setup:** there is none to add — `WalletProvider` (mounted in `main.jsx`) IS this
context, and `useWeb3()` reads it. A separate `Web3Provider` existed until spec 110 and was
never rendered; this snippet described mounting it, which is why it is gone rather than
updated.

```jsx
// src/main.jsx — the real tree
<WalletProvider>
  <App />
</WalletProvider>
```

#### 2. UIContext (`src/contexts/UIContext.jsx`)

Manages all UI-related state including:
- Notifications (user feedback messages)
- Announcements (screen reader accessibility)
- Modals (dialog system)
- Error handling (global error state)

**Provider Setup:**
```jsx
import { UIProvider } from './contexts/UIContext'

<UIProvider>
  <App />
</UIProvider>
```

### Custom Hooks

#### Web3 Hooks (`src/hooks/useWeb3.js`)

- **`useWeb3()`** - Access full Web3 context
- **`useAccount()`** - Get account and connection state
- **`useNetwork()`** - Get network state and switch function
- **`useEthers()`** - Get provider and signer instances
- **`useWallet()`** - Access wallet connection functions

**Example:**
```jsx
import { useWeb3, useAccount, useEthers } from './hooks/useWeb3'

function MyComponent() {
  const { account, isConnected } = useAccount()
  const { provider, signer } = useEthers()
  
  // Use the values...
}
```

#### UI Hooks (`src/hooks/useUI.js`)

- **`useUI()`** - Access full UI context
- **`useNotification()`** - Show/hide notifications
- **`useAnnouncement()`** - Make screen reader announcements
- **`useModal()`** - Show/hide modals
- **`useError()`** - Handle errors globally

**Example:**
```jsx
import { useNotification, useAnnouncement } from './hooks/useUI'

function MyComponent() {
  const { showNotification } = useNotification()
  const { announce } = useAnnouncement()
  
  const handleAction = () => {
    showNotification('Action completed!', 'success')
    announce('Action completed successfully')
  }
}
```

#### Blockchain Event Hooks (`src/hooks/useBlockchainEvents.js`)

- **`useContractEvent(contract, eventName, handler, notify)`** - Listen to single contract event
- **`useContractEvents(contract, events)`** - Listen to multiple contract events
- **`useAccountChange(callback)`** - Listen to wallet account changes
- **`useChainChange(callback)`** - Listen to network changes

**Example:**
```jsx
import { useContractEvent } from './hooks/useBlockchainEvents'

function MyComponent() {
  const contract = ... // your contract instance
  
  useContractEvent(
    contract,
    'ProposalSubmitted',
    (proposalId, proposer) => {
      console.log('New proposal:', proposalId)
      // Handle the event
    },
    true // show notification
  )
}
```

### UI Components

#### NotificationSystem (`src/components/ui/NotificationSystem.jsx`)

Displays toast-style notifications with different types:
- `info` - Information messages (blue)
- `success` - Success messages (green)
- `warning` - Warning messages (orange)
- `error` - Error messages (red)

Auto-dismisses after 5 seconds by default.

#### ModalSystem (`src/components/ui/ModalSystem.jsx`)

Displays modal dialogs with:
- Focus management (traps focus inside modal)
- Keyboard support (Escape to close)
- Backdrop click to close (configurable)
- Accessible (ARIA attributes)

**Example:**
```jsx
import { useModal } from './hooks/useUI'

function MyComponent() {
  const { showModal, hideModal } = useModal()
  
  const openDialog = () => {
    showModal(
      <div>
        <p>Modal content here</p>
        <button onClick={hideModal}>Close</button>
      </div>,
      { 
        title: 'My Dialog',
        size: 'medium',
        closable: true
      }
    )
  }
}
```

#### AnnouncementRegion (`src/components/ui/AnnouncementRegion.jsx`)

Hidden region for screen reader announcements. Automatically announces important state changes for accessibility.

#### ErrorBoundary (`src/components/ui/ErrorBoundary.jsx`)

Catches React errors and displays a fallback UI. Prevents entire app crashes from component errors.

## Usage Patterns

### 1. Removing Prop Drilling

**Before:**
```jsx
function App() {
  const [account, setAccount] = useState(null)
  return <Dashboard account={account} />
}

function Dashboard({ account }) {
  return <UserProfile account={account} />
}

function UserProfile({ account }) {
  return <div>{account}</div>
}
```

**After:**
```jsx
function App() {
  return <Dashboard />
}

function Dashboard() {
  return <UserProfile />
}

function UserProfile() {
  const { account } = useAccount()
  return <div>{account}</div>
}
```

### 2. Transaction Feedback

```jsx
import { useNotification, useAnnouncement } from './hooks/useUI'

function TransactionButton() {
  const { showNotification } = useNotification()
  const { announce } = useAnnouncement()
  
  const handleTransaction = async () => {
    try {
      showNotification('Transaction submitted...', 'info', 0)
      announce('Transaction submitted')
      
      const tx = await contract.submitTransaction()
      const receipt = await tx.wait()
      
      showNotification('Transaction successful!', 'success')
      announce('Transaction completed successfully')
    } catch (error) {
      showNotification('Transaction failed', 'error')
      announce('Transaction failed')
    }
  }
  
  return <button onClick={handleTransaction}>Submit</button>
}
```

### 3. Real-time Event Listening

```jsx
import { useContractEvents } from './hooks/useBlockchainEvents'

function ProposalList() {
  const contract = ... // your contract
  
  useContractEvents(contract, [
    {
      name: 'ProposalSubmitted',
      handler: (id, proposer) => {
        console.log('New proposal:', id)
        refreshProposals()
      },
      notify: true,
      message: 'New proposal submitted!'
    },
    {
      name: 'VoteCast',
      handler: (voter, proposalId) => {
        console.log('Vote cast:', proposalId)
        refreshVotes()
      },
      notify: true,
      message: 'Vote cast on proposal!'
    }
  ])
  
  return <div>...</div>
}
```

## Testing

### State Persistence

State is maintained across:
- Navigation between routes
- Component unmounting/remounting
- Network changes
- Account changes

### Event Responsiveness

The system responds to:
- Blockchain events (contract events)
- Wallet events (account/network changes)
- User interactions (clicks, form submissions)
- Transaction lifecycle (submitted, confirmed, failed)

## Accessibility

All state management components follow WCAG 2.1 AA guidelines:

- **Notifications**: Proper ARIA live regions (`polite` or `assertive`)
- **Announcements**: Screen reader friendly announcements for state changes
- **Modals**: Focus trapping, keyboard navigation, ARIA attributes
- **Error Boundaries**: Accessible error messages and recovery options

## Best Practices

1. **Use the right hook**: Use specific hooks (`useAccount`, `useNotification`) instead of generic ones (`useWeb3`, `useUI`) when you only need specific functionality.

2. **Avoid unnecessary re-renders**: Hooks use memoization internally, but be mindful of creating new callback functions in render.

3. **Clean up listeners**: Event listeners are automatically cleaned up, but be aware of potential memory leaks with long-running subscriptions.

4. **Error handling**: Always wrap async operations in try-catch and provide user feedback.

5. **Accessibility first**: Always use both notifications (visual) and announcements (screen reader) for important state changes.

## File Structure

```
frontend/src/
├── contexts/
│   ├── Web3Context.jsx      # Web3 state management
│   ├── UIContext.jsx         # UI state management
│   └── index.js              # Context exports
├── hooks/
│   ├── useWeb3.js            # Web3 hooks
│   ├── useUI.js              # UI hooks
│   ├── useBlockchainEvents.js # Event listener hooks
│   └── index.js              # Hook exports
└── components/
    └── ui/
        ├── NotificationSystem.jsx
        ├── ModalSystem.jsx
        ├── AnnouncementRegion.jsx
        └── ErrorBoundary.jsx
```

## Migration Guide

To migrate existing components:

1. Remove props for `account`, `provider`, `signer`, `networkError`
2. Import and use appropriate hooks (`useAccount`, `useEthers`, etc.)
3. Replace inline state management with context hooks
4. Add notification/announcement calls for user feedback
5. Test component still works without prop drilling

Example:
```jsx
// Before
function MyComponent({ provider, signer, account }) {
  // ...
}

// After
import { useEthers, useAccount } from '../hooks/useWeb3'

function MyComponent() {
  const { provider, signer } = useEthers()
  const { account } = useAccount()
  // ...
}
```
