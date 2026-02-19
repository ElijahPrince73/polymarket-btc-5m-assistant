// Add endpoints for live trading control
app.post('/api/live/start-trading', (req, res) => {
    // Logic to start trading
    try {
        tradingActive = true; // Flag to indicate trading is active
        console.log('Trading started!');
        res.status(200).json({ message: 'Trading started!' });
    } catch (error) {
        console.error('Error starting trading:', error);
        res.status(500).json({ error: 'Failed to start trading' });
    }
});

app.post('/api/live/stop-trading', (req, res) => {
    // Logic to stop trading
    try {
        tradingActive = false; // Flag to indicate trading is inactive
        console.log('Trading stopped!');
        res.status(200).json({ message: 'Trading stopped!' });
    } catch (error) {
        console.error('Error stopping trading:', error);
        res.status(500).json({ error: 'Failed to stop trading' });
    }
});