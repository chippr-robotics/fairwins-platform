import { useState } from 'react'
import { Button, Card, Badge, StatusIndicator, FormGroup, Input, HelperText, LoadingScreen } from './index'
import './ComponentExamples.css'

/**
 * Component Examples
 * 
 * Interactive examples showcasing all UI components.
 * Use this as a reference or documentation.
 */
function ComponentExamples() {
  const [formData, setFormData] = useState({
    title: '',
    email: '',
    amount: ''
  })
  const [loading, setLoading] = useState(false)
  const [errors, setErrors] = useState({})
  const [showLoadingScreen, setShowLoadingScreen] = useState(false)
  const [showInlineLoading, setShowInlineLoading] = useState(false)

  const handleChange = (field, value) => {
    setFormData(prev => ({ ...prev, [field]: value }))
    // Clear error when user types
    if (errors[field]) {
      setErrors(prev => ({ ...prev, [field]: '' }))
    }
  }

  const handleSubmit = () => {
    setLoading(true)
    setTimeout(() => {
      setLoading(false)
      alert('Form submitted!')
    }, 2000)
  }

  const handleCardClick = () => {
    alert('Card clicked!')
  }

  return (
    <div className="component-examples">
      <div className="examples-container">
        <h1>UI Component Library Examples</h1>
        <p className="intro">
          Interactive examples of all base UI components following the brand design system.
        </p>

        {/* Buttons Section */}
        <section className="example-section">
          <h2>Buttons</h2>
          <div className="example-grid">
            <div className="example-item">
              <h3>Primary Button</h3>
              <Button onClick={() => alert('Primary clicked')}>
                Primary Action
              </Button>
            </div>

            <div className="example-item">
              <h3>Secondary Button</h3>
              <Button variant="secondary" onClick={() => alert('Secondary clicked')}>
                Secondary Action
              </Button>
            </div>

            <div className="example-item">
              <h3>Loading Button</h3>
              <Button loading={loading} onClick={handleSubmit}>
                {loading ? 'Processing...' : 'Submit'}
              </Button>
            </div>

            <div className="example-item">
              <h3>Disabled Button</h3>
              <Button disabled>
                Disabled
              </Button>
            </div>
          </div>
        </section>

        {/* Cards Section */}
        <section className="example-section">
          <h2>Cards</h2>
          <div className="example-grid">
            <div className="example-item">
              <h3>Basic Card</h3>
              <Card>
                <h4>Card Title</h4>
                <p>This is a basic card with content.</p>
              </Card>
            </div>

            <div className="example-item">
              <h3>Hover Card</h3>
              <Card hover>
                <h4>Hover Over Me</h4>
                <p>This card has hover effects.</p>
              </Card>
            </div>

            <div className="example-item">
              <h3>Interactive Card</h3>
              <Card 
                hover 
                onClick={handleCardClick}
                ariaLabel="Clickable card example"
              >
                <h4>Click or Press Enter</h4>
                <p>This card is fully interactive and keyboard accessible.</p>
              </Card>
            </div>
          </div>
        </section>

        {/* Badges Section */}
        <section className="example-section">
          <h2>Badges</h2>
          <div className="example-badges">
            <Badge variant="success" icon="✓">Active</Badge>
            <Badge variant="warning" icon="⏳">Pending</Badge>
            <Badge variant="danger" icon="❌">Failed</Badge>
            <Badge variant="neutral">Draft</Badge>
          </div>
        </section>

        {/* Status Indicators Section */}
        <section className="example-section">
          <h2>Status Indicators</h2>
          <div className="example-statuses">
            <StatusIndicator status="active" />
            <StatusIndicator status="pending" />
            <StatusIndicator status="reviewing" />
            <StatusIndicator status="cancelled" />
            <StatusIndicator status="executed" />
            <StatusIndicator status="forfeited" />
            <StatusIndicator status="completed" />
            <StatusIndicator status="failed" />
          </div>
        </section>

        {/* Form Components Section */}
        <section className="example-section">
          <h2>Form Components</h2>
          
          <Card>
            <h3>Complete Form Example</h3>
            <form onSubmit={(e) => { e.preventDefault(); handleSubmit(); }}>
              <FormGroup
                label="Proposal Title"
                id="proposalTitle"
                value={formData.title}
                onChange={(e) => handleChange('title', e.target.value)}
                placeholder="Enter a descriptive title"
                helperText="Brief, clear description of your proposal"
                required
                error={errors.title}
              />

              <FormGroup
                label="Email Address"
                id="email"
                type="email"
                value={formData.email}
                onChange={(e) => handleChange('email', e.target.value)}
                placeholder="your@email.com"
                helperText="We'll never share your email"
                required
                error={errors.email}
              />

              <FormGroup
                label="Amount"
                id="amount"
                type="number"
                value={formData.amount}
                onChange={(e) => handleChange('amount', e.target.value)}
                placeholder="0.00"
                helperText="Amount in POL"
                required
                error={errors.amount}
              />

              <div className="form-actions">
                <Button type="submit" loading={loading}>
                  Submit Proposal
                </Button>
                <Button 
                  type="button" 
                  variant="secondary"
                  onClick={() => setFormData({ title: '', email: '', amount: '' })}
                >
                  Reset
                </Button>
              </div>
            </form>
          </Card>

          <div className="example-item" style={{ marginTop: '2rem' }}>
            <h3>Individual Input</h3>
            <Input
              id="standaloneInput"
              placeholder="Standalone input field"
              value=""
              onChange={() => {}}
            />
            <HelperText>This is a standalone input with helper text</HelperText>
          </div>
        </section>

        {/* Accessibility Info */}
        <section className="example-section">
          <Card>
            <h2>Accessibility Features</h2>
            <ul className="accessibility-list">
              <li>✓ All components keyboard accessible (Tab, Enter, Space)</li>
              <li>✓ Visible focus indicators on all interactive elements</li>
              <li>✓ Proper ARIA attributes for screen readers</li>
              <li>✓ Form labels associated with inputs</li>
              <li>✓ Error messages announced via aria-live regions</li>
              <li>✓ Status indicators use icons + color (never color alone)</li>
              <li>✓ Interactive cards support keyboard navigation</li>
              <li>✓ Respects prefers-reduced-motion</li>
              <li>✓ Color contrast meets WCAG 2.1 AA standards</li>
            </ul>
          </Card>
        </section>

        {/* Usage Instructions */}
        <section className="example-section">
          <Card>
            <h2>How to Use</h2>
            <div className="usage-code">
              <pre>{`import { Button, Card, Badge, FormGroup } from '@/components/ui'

function MyComponent() {
  return (
    <Card hover>
      <h3>My Card</h3>
      <Badge variant="success">Active</Badge>
      
      <FormGroup
        label="Name"
        id="name"
        value={name}
        onChange={(e) => setName(e.target.value)}
        required
      />
      
      <Button onClick={handleSubmit}>
        Submit
      </Button>
    </Card>
  )
}`}</pre>
            </div>
          </Card>
        </section>

        {/* LoadingScreen Section */}
        <section className="example-section">
          <h2>Loading Screen</h2>
          <p>Animated 4-leaf clover loading indicator for FairWins.</p>
          
          <div className="example-grid">
            <div className="example-item">
              <h3>Fullscreen Loading</h3>
              <Button onClick={() => {
                setShowLoadingScreen(true)
                setTimeout(() => setShowLoadingScreen(false), 4000)
              }}>
                Show Fullscreen Loading (4s)
              </Button>
              <LoadingScreen visible={showLoadingScreen} />
            </div>

            <div className="example-item">
              <h3>Inline Loading - Small</h3>
              <Button onClick={() => {
                setShowInlineLoading(true)
                setTimeout(() => setShowInlineLoading(false), 3000)
              }}>
                Toggle Inline Loading
              </Button>
              <div style={{ marginTop: '1rem', minHeight: '120px', border: '1px solid var(--border-color)', borderRadius: '8px', padding: '1rem' }}>
                {showInlineLoading ? (
                  <LoadingScreen visible={true} inline size="small" text="Loading data" />
                ) : (
                  <p>Content loaded!</p>
                )}
              </div>
            </div>

            <div className="example-item">
              <h3>Different Sizes</h3>
              <div style={{ display: 'flex', gap: '2rem', alignItems: 'center', flexWrap: 'wrap' }}>
                <div>
                  <p style={{ fontSize: '0.875rem', marginBottom: '0.5rem' }}>Small</p>
                  <LoadingScreen visible={true} inline size="small" text="" />
                </div>
                <div>
                  <p style={{ fontSize: '0.875rem', marginBottom: '0.5rem' }}>Medium</p>
                  <LoadingScreen visible={true} inline size="medium" text="" />
                </div>
                <div>
                  <p style={{ fontSize: '0.875rem', marginBottom: '0.5rem' }}>Large</p>
                  <LoadingScreen visible={true} inline size="large" text="" />
                </div>
              </div>
            </div>
          </div>

          <Card style={{ marginTop: '2rem' }}>
            <h3>Usage Example</h3>
            <div className="code-example">
              <pre>{`import { LoadingScreen } from './components/ui'

function MyComponent() {
  const [isLoading, setIsLoading] = useState(true)

  return (
    <>
      <LoadingScreen visible={isLoading} text="Loading data" />
      {/* Your content */}
    </>
  )
}`}</pre>
            </div>
          </Card>
        </section>
      </div>
    </div>
  )
}

export default ComponentExamples
