import React, { useState, useRef, useEffect, useCallback } from 'react';

const AuthorAnimationPopup = ({ onClose }) => {
    const lettersToAnimate = "ANURAAG".split(''); // Letters to pick from
    const [fallingLetters, setFallingLetters] = useState([]);
    const containerRef = useRef(null);
    const letterCounter = useRef(0); // To generate unique IDs for each letter instance

    // Function to generate properties for a new falling letter
    const generateRandomLetter = useCallback(() => {
        const container = containerRef.current;
        if (!container) return null; // Ensure container is rendered

        const containerWidth = container.offsetWidth;
        const containerHeight = container.offsetHeight;

        const letter = lettersToAnimate[Math.floor(Math.random() * lettersToAnimate.length)];
        const startX = Math.random() * (containerWidth - 50); // Random X position within container
        const size = 30 + Math.random() * 40; // Random font size between 30px and 70px
        const duration = 5 + Math.random() * 3; // Random duration for fall and bounce (5-8 seconds)
        const delay = Math.random() * 2; // Random delay before animation starts (0-2 seconds)
        const initialRotation = Math.random() * 360; // Random initial rotation
        // Rotate 1-2 full turns in either direction
        const rotationTarget = initialRotation + (Math.random() > 0.5 ? 1 : -1) * (360 * (1 + Math.random()));

        letterCounter.current += 1; // Increment counter for unique ID

        return {
            id: `letter-${letterCounter.current}-${Date.now()}`, // Unique ID
            letter,
            startX,
            size,
            duration,
            delay,
            initialRotation,
            rotationTarget,
            color: `hsl(${Math.random() * 360}, 70%, 60%)`, // Random vibrant color
            containerHeight: containerHeight, // Pass container height for CSS variable
        };
    }, [lettersToAnimate]);

    // Effect to continuously add new letters
    useEffect(() => {
        const addLetterInterval = setInterval(() => {
            const newLetter = generateRandomLetter();
            if (newLetter) {
                setFallingLetters(prevLetters => [...prevLetters, newLetter]);
            }
        }, 500); // Add a new letter every 0.5 seconds

        return () => clearInterval(addLetterInterval); // Cleanup interval on unmount
    }, [generateRandomLetter]);

    // Effect to remove letters after their animation finishes
    useEffect(() => {
        const cleanupTimeouts = [];
        fallingLetters.forEach(letter => {
            // Set a timeout to remove the letter after its animation duration + delay + a small buffer
            const timeout = setTimeout(() => {
                setFallingLetters(prevLetters => prevLetters.filter(l => l.id !== letter.id));
            }, (letter.duration + letter.delay) * 1000 + 100); // Convert to ms, add 100ms buffer

            cleanupTimeouts.push(timeout);
        });

        return () => cleanupTimeouts.forEach(clearTimeout); // Cleanup timeouts on re-render or unmount
    }, [fallingLetters]); // Re-run this effect when fallingLetters array changes

    return (
        <div className="author-overlay" onClick={onClose}>
            <div className="author-popup" ref={containerRef} onClick={(e) => e.stopPropagation()}>
                {fallingLetters.map(item => (
                    <span
                        key={item.id}
                        className="falling-letter"
                        style={{
                            left: item.startX,
                            fontSize: `${item.size}px`,
                            color: item.color,
                            // Pass dynamic values as CSS variables
                            '--initial-rotation': `${item.initialRotation}deg`,
                            '--rotation-target': `${item.rotationTarget}deg`,
                            '--letter-size': `${item.size}px`,
                            '--popup-height': `${item.containerHeight}px`,
                            // Apply the new fall-bounce animation
                            animation: `fall-bounce ${item.duration}s ease-in-out ${item.delay}s forwards`,
                        }}
                    >
                        {item.letter}
                    </span>
                ))}
                <div className="author-center-text">
                    ANURAAG
                </div>
            </div>
        </div>
    );
};



export default AuthorAnimationPopup;