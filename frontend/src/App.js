import React, { useState, useRef, useEffect, useCallback } from 'react';
import {
    Scissors,
    Send,
    Upload,
    Play,
    Pause,
    Download,
    Loader2,
    FileAudio,
    Save,
    FileText,
    Trash,
    Trash2,
    FileJson,
    FileCode,
    Plus,
    ArrowUp,
    ArrowDown,
    Undo,
    ZoomIn,
    ZoomOut,
    Hash,
    ChevronDown,
    ChevronRight,
} from 'lucide-react';

const AudioTranscriptionApp = () => {
    const [audioFile, setAudioFile] = useState(null);
    const [audioUrl, setAudioUrl] = useState('');
    const [isPlaying, setIsPlaying] = useState(false);
    const [currentTime, setCurrentTime] = useState(0);
    const [duration, setDuration] = useState(0);
    const [waveformData, setWaveformData] = useState([]);
    const [transcriptionData, setTranscriptionData] = useState(null);
    const [viewMode, setViewMode] = useState('sentences');
    const [isProcessing, setIsProcessing] = useState(false);
    const [uploadProgress, setUploadProgress] = useState(0);
    const [error, setError] = useState('');
    const [selectedBlockIndex, setSelectedBlockIndex] = useState(null);
    const [isDragging, setIsDragging] = useState(false);
    const [dragType, setDragType] = useState(null); // 'start' or 'end'
    const [editableBlocks, setEditableBlocks] = useState([]);
    const [hasUnsavedChanges, setHasUnsavedChanges] = useState(false);
    const [originalTranscriptionData, setOriginalTranscriptionData] = useState([]); // Stores the raw, unedited transcription data
    const [deletedBlocks, setDeletedBlocks] = useState([]); // For undo functionality
    const [zoomLevel, setZoomLevel] = useState(1); // For zoom functionality
    const [nextBlockId, setNextBlockId] = useState(1000); // For new blocks
    const [quickReorderPosition, setQuickReorderPosition] = useState(''); // For quick reorder input
    const [scrollOffset, setScrollOffset] = useState(0);
    const [enablePanning, setEnablePanning] = useState(false);
    const [expandedBlocks, setExpandedBlocks] = useState(new Set()); // Track which 



    // Custom View states
    const [customBlocks, setCustomBlocks] = useState([]); // For custom view editing
    const [isCustomMode, setIsCustomMode] = useState(false); // Track if we're in custom mode
    const [customText, setCustomText] = useState(''); // Combined text for custom editing
    const [selectedText, setSelectedText] = useState(''); // For text selection
    const [selectionStart, setSelectionStart] = useState(0);
    const [selectionEnd, setSelectionEnd] = useState(0);
    const [selectedCustomBlockIndex, setSelectedCustomBlockIndex] = useState(null);


    const audioRef = useRef();
    const canvasRef = useRef();
    const fileInputRef = useRef();
    const waveformContainerRef = useRef(); // Reference to the container element
    const customTextRef = useRef(); // Reference to custom text area



    const isDraggingWaveform = useRef(false);
    const dragStartX = useRef(null);
    // Using a ref to hold the *latest* scrollOffset state value, for direct access in event handlers
    const scrollOffsetRef = useRef(0);

    const API_BASE = 'https://staging.brinx.ai/aud-tool/';

    // Colors for different block types with alternating shades
    const blockColors = {
        words: [
            {
                bg: 'rgba(52, 144, 220, 0.3 )',
                border: '#3490dc',
                selected: 'rgba(52, 144, 220, 0.6)',
            },
            {
                bg: 'rgba(66, 153, 225, 0.3)',
                border: '#4299e1',
                selected: 'rgba(66, 153, 225, 0.6)',
            },
        ],
        sentences: [
            {
                bg: 'rgba(72, 187, 120, 0.3)',
                border: '#48bb78',
                selected: 'rgba(72, 187, 120, 0.6)',
            },
            {
                bg: 'rgba(104, 211, 145, 0.3)',
                border: '#68d391',
                selected: 'rgba(104, 211, 145, 0.6)',
            },
        ],
        paragraphs: [
            {
                bg: 'rgba(237, 137, 54, 0.3)',
                border: '#ed8936',
                selected: 'rgba(237, 137, 54, 0.6)',
            },
            {
                bg: 'rgba(246, 173, 85, 0.3)',
                border: '#f6ad55',
                selected: 'rgba(246, 173, 85, 0.6)',
            },
        ],
    };

    // Helper to get raw data based on view mode for originalTranscriptionData
    const getRawDisplayData = (data) => {
        if (!data) return [];
        switch (viewMode) {
            case 'words':
                return data.words || [];
            case 'sentences':
                return data.sentences || [];
            case 'paragraphs':
                return data.paragraphs || [];
            default:
                return [];
        }
    };

    useEffect(() => {
        if (transcriptionData && viewMode === 'custom') {
            // Initialize custom view with combined text from all sentences
            const baseViewMode = 'sentences'; // Default to sentences for custom view
            const rawData = transcriptionData[baseViewMode] || [];
            
            // Combine all text into one block for custom editing
            const combinedText = rawData.map(item => item.text || item.word).join(' ');
            
            // Start with empty custom blocks - user will create their own sections
            setCustomBlocks([]);
            setCustomText(combinedText);
        }
    }, [transcriptionData, viewMode]);

    // Initialize editable blocks when transcription data changes
    useEffect(() => {
        if (transcriptionData && viewMode !== 'custom') {
            // Only initialize from backend data if we don't have custom published blocks
            if (!hasUnsavedChanges || editableBlocks.length === 0) {
                // Set originalTranscriptionData once with the raw, unedited data
                setOriginalTranscriptionData(
                    getRawDisplayData(transcriptionData).map((item, index) => ({
                        id: `original-${index}`,
                        text: item.text || item.word,
                        start: item.start,
                        end: item.end,
                        originalText: item.text || item.word,
                    }))
                );

                const blocks = getRawDisplayData(transcriptionData).map((item, index) => ({
                    id: `block-${index}`,
                    text: item.text || item.word,
                    start: item.start,
                    end: item.end,
                    originalIndex: index,
                    confidence: item.probability || item.confidence || 0.95,
                    isUserAdded: false,
                    originalText: item.text || item.word, // Store original text for merging/unmerging
                }));
                setEditableBlocks(blocks);
                setHasUnsavedChanges(false);
                setNextBlockId(blocks.length + 1000);
            }
            setIsCustomMode(false);
        } else if (viewMode === 'custom') {
            setIsCustomMode(true);
        }
    }, [transcriptionData, viewMode]);



    // Function to calculate timing for custom blocks using word data
    const calculateCustomBlockTiming = (blockText) => {
        if (!transcriptionData || !transcriptionData.words) {
            return { start: 0, end: 1 };
        }

        const words = transcriptionData.words;
        const blockWords = blockText.toLowerCase().split(/\s+/).filter(w => w.length > 0);

        if (blockWords.length === 0) return { start: 0, end: 1 };

        let startTime = null;
        let endTime = null;
        let currentWordIndexInBlock = 0;

        // Iterate through the transcription words to find the sequence of blockWords
        for (let i = 0; i < words.length; i++) {
            const word = words[i];
            const cleanedWordText = (word.text || word.word || "").toLowerCase().replace(/[^\w]/g, "");
            const cleanedBlockWord = blockWords[currentWordIndexInBlock].replace(/[^\w]/g, "");

            if (cleanedWordText === cleanedBlockWord) {
                if (startTime === null) {
                    startTime = word.start;
                }
                endTime = word.end;
                currentWordIndexInBlock++;

                // If all words in the block have been matched sequentially
                if (currentWordIndexInBlock === blockWords.length) {
                    break; // Found the full sequence
                }
            } else {
                // Reset if the sequence is broken, unless we haven't started matching yet
                if (startTime !== null) {
                    startTime = null;
                    endTime = null;
                    currentWordIndexInBlock = 0;
                }
            }
        }

        return {
            start: startTime !== null ? startTime : 0,
            end: endTime !== null ? endTime : (startTime !== null ? startTime + 1 : 1),
        };
    };


    const getCombinedCustomText = () => {
        return customText;
    };

    // Update combined text
    const updateCombinedCustomText = (newText) => {
        setCustomText(newText);
    };

    const createCustomBlockFromSelection = () => {
        if (!selectedText || selectionStart === selectionEnd) {
            setError('Please select text to create a block');
            return;
        }

        // Create a new custom block from the selected text
        const newBlock = {
            id: `custom-${Date.now()}`,
            text: selectedText.trim(),
            originalText: selectedText.trim(),
            isEdited: false,
        };

        setCustomBlocks(prev => [...prev, newBlock]);

        // Clear selection
        setSelectedText('');
        setSelectionStart(0);
        setSelectionEnd(0);
    };


    // Generate waveform data from audio
    const generateWaveform = async (audioFile) => {
        try {
            const audioContext = new (window.AudioContext || window.webkitAudioContext)();
            const arrayBuffer = await audioFile.arrayBuffer();
            const audioData = await audioContext.decodeAudioData(arrayBuffer);

            const rawData = audioData.getChannelData(0);
            const samples = 800; // Adjust samples based on zoom level
            const blockSize = Math.floor(rawData.length / samples);
            const filteredData = [];

            for (let i = 0; i < samples; i++) {
                let blockStart = blockSize * i;
                let sum = 0;
                for (let j = 0; j < blockSize; j++) {
                    sum += Math.abs(rawData[blockStart + j] || 0);
                }
                filteredData.push(sum / blockSize);
            }

            const max = Math.max(...filteredData);
            return filteredData.map((val) => val / max);
        } catch (error) {
            console.error('Error generating waveform:', error);
            return [];
        }
    };

    // Regenerate waveform when zoom level changes
    useEffect(() => {
        if (audioFile) {
            generateWaveform(audioFile).then(setWaveformData);
        }
    }, [zoomLevel, audioFile]);

    // Helper function to draw individual blocks
    const drawBlock = (
        ctx,
        block,
        blockIndex,
        canvasWidth, // The actual drawing width of the canvas
        height,
        isSelected,
        scrollOffsetVal,
        zoomLevelVal
    ) => {
        // Calculate start and end X coordinates on the canvas, considering zoom and scroll
        const startX = (block.start / duration) * canvasWidth * zoomLevelVal - scrollOffsetVal;
        const endX = (block.end / duration) * canvasWidth * zoomLevelVal - scrollOffsetVal;

        const blockWidth = endX - startX;

        // Use alternating colors based on index
        const colorIndex = blockIndex % 2;
        const colors = blockColors[viewMode][colorIndex];

        // Draw block background
        ctx.fillStyle = isSelected ? colors.selected : colors.bg;
        ctx.fillRect(startX, 0, blockWidth, height);

        // Draw block borders
        ctx.strokeStyle = colors.border;
        ctx.lineWidth = isSelected ? 3 : 2; // Thicker border for selected
        ctx.beginPath();
        ctx.moveTo(startX, 0);
        ctx.lineTo(startX, height);
        ctx.moveTo(endX, 0);
        ctx.lineTo(endX, height);
        ctx.stroke();

        // Draw resize handles for selected block
        if (isSelected) {
            const handleSize = 10; // Larger handles for better grabbing
            ctx.fillStyle = colors.border;

            // Start handle
            ctx.fillRect(
                startX - handleSize / 2,
                height / 2 - handleSize / 2,
                handleSize,
                handleSize
            );

            // End handle
            ctx.fillRect(
                endX - handleSize / 2,
                height / 2 - handleSize / 2,
                handleSize,
                handleSize
            );

            // Add white border to handles for better visibility
            ctx.strokeStyle = '#ffffff';
            ctx.lineWidth = 1;
            ctx.strokeRect(
                startX - handleSize / 2,
                height / 2 - handleSize / 2,
                handleSize,
                handleSize
            );
            ctx.strokeRect(
                endX - handleSize / 2,
                height / 2 - handleSize / 2,
                handleSize,
                handleSize
            );
        }
    };

    // Draw waveform with highlighted blocks
    const drawWaveform = useCallback(() => {
        if (!canvasRef.current || waveformData.length === 0 || !duration) return;

        const canvas = canvasRef.current;
        const ctx = canvas.getContext('2d');
        const container = waveformContainerRef.current; // Get the container for responsive sizing

        // Get the actual displayed width of the container
        const displayWidth = container ? container.clientWidth : canvas.width; // Fallback to canvas.width if container not found

        // Set canvas drawing dimensions to match display dimensions for proper scaling
        canvas.width = displayWidth;
        canvas.height = 150; // Keep fixed height for drawing as per current setup

        const width = canvas.width; // Now 'width' is the effective drawing width
        const height = canvas.height;

        ctx.clearRect(0, 0, width, height);

        // Draw waveform bars
        ctx.fillStyle = 'black';
        const barWidth = (width / waveformData.length) * zoomLevel;

        waveformData.forEach((value, index) => {
            const barHeight = value * height * 0.8;
            const x = index * barWidth - scrollOffset; // Use the state variable directly
            const y = (height - barHeight) / 2;

            ctx.fillRect(x, y, barWidth - 0.5, barHeight);
        });

        // Sort blocks by start time for proper layering
        const sortedBlocks = [...editableBlocks]
            .map((block, index) => ({ ...block, currentEditableIndex: index }))
            .sort((a, b) => a.start - b.start);

        // Draw non-selected blocks first
        sortedBlocks.forEach((block) => {
            if (selectedBlockIndex !== block.currentEditableIndex) {
                drawBlock(
                    ctx,
                    block,
                    block.currentEditableIndex,
                    width, // Pass the dynamic canvas width
                    height,
                    false,
                    scrollOffset,
                    zoomLevel
                );
            }
        });

        // Draw selected block last (highest z-index)
        if (selectedBlockIndex !== null) {
            const selectedBlock = editableBlocks[selectedBlockIndex];
            if (selectedBlock) {
                drawBlock(
                    ctx,
                    selectedBlock,
                    selectedBlockIndex,
                    width, // Pass the dynamic canvas width
                    height,
                    true,
                    scrollOffset,
                    zoomLevel
                );
            }
        }

        // Draw progress line
        const progressX = (currentTime / duration) * width * zoomLevel - scrollOffset;

        // Update the ref *after* all rendering logic has used the current scrollOffset state,
        // ensuring the ref reflects the latest *rendered* scroll position.
        scrollOffsetRef.current = scrollOffset;

        ctx.strokeStyle = '#dc3545';
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.moveTo(progressX, 0);
        ctx.lineTo(progressX, height);
        ctx.stroke();
    }, [
        waveformData,
        currentTime,
        duration,
        editableBlocks,
        selectedBlockIndex,
        viewMode,
        zoomLevel,
        scrollOffset, // Dependency for re-drawing on scroll
    ]);


    const publishCustomBlocks = () => {
        if (customBlocks.length === 0) {
          setError('No custom blocks to publish');
          return;
        }
    
        const publishedBlocks = customBlocks.map((customBlock, index) => {
          const timing = calculateCustomBlockTiming(customBlock.text);
    
          return {
            id: `published-${index}`,
            text: customBlock.text,
            start: timing.start,
            end: timing.end,
            originalIndex: index,
            confidence: 0.95,
            isUserAdded: true, // Mark as user-added to distinguish from backend data
            originalText: customBlock.text,
          };
        });
    
        // Set the published blocks as editable blocks
        setEditableBlocks(publishedBlocks);
    
        // Update original transcription data for text calculations
        setOriginalTranscriptionData(
          publishedBlocks.map((block, index) => ({
            id: `original-${index}`,
            text: block.text,
            start: block.start,
            end: block.end,
            originalText: block.text,
          }))
        );
    
        // Mark as having unsaved changes to prevent reset
        setHasUnsavedChanges(true);
    
        // Switch back to sentences view to show the published blocks
        setViewMode('sentences');
        setIsCustomMode(false);
    
        // Clear any errors
        setError('');
      };

    // Update custom block text
    const updateCustomBlockText = (blockIndex, newText) => {
        const updatedBlocks = [...customBlocks];
        updatedBlocks[blockIndex] = {
            ...updatedBlocks[blockIndex],
            text: newText,
            isEdited: true,
        };
        setCustomBlocks(updatedBlocks);
    };

    const deleteCustomBlock = (blockIndex) => {
        const updatedBlocks = customBlocks.filter((_, index) => index !== blockIndex);
        setCustomBlocks(updatedBlocks);
    };


    // Converts time (seconds) to X coordinate on the canvas
    const getXFromTime = useCallback((time) => {
        const canvas = canvasRef.current;
        if (!canvas || !duration) return 0;
        // Ensure canvas.width is current before calculation
        const currentCanvasWidth = waveformContainerRef.current ? waveformContainerRef.current.clientWidth : canvas.width;
        return (time / duration) * currentCanvasWidth * zoomLevel - scrollOffsetRef.current;
    }, [duration, zoomLevel]); // Dependencies ensure this function updates if these change

    // Converts X coordinate on the canvas to time (seconds)
    const getTimeFromX = useCallback((x) => {
        const canvas = canvasRef.current;
        if (!canvas || !duration) return 0;
        // Ensure canvas.width is current before calculation
        const currentCanvasWidth = waveformContainerRef.current ? waveformContainerRef.current.clientWidth : canvas.width;
        // x is clientX - rect.left, so it's already relative to the visual start of the canvas.
        // Adding scrollOffsetRef.current translates it to the "absolute" waveform coordinate.
        return ((x + scrollOffsetRef.current) / (currentCanvasWidth * zoomLevel)) * duration;
    }, [duration, zoomLevel]); // Dependencies ensure this function updates if these change

    const getWordsForBlock = (block, blockIndex) => {
        if (viewMode === 'words') return []; // No sub-words for word view

        // If the block has words property, use it
        if (block.words && Array.isArray(block.words)) {
            return block.words;
        }

        // Otherwise, try to extract words from the original transcription data
        if (transcriptionData && transcriptionData.words) {
            const tolerance = 0.05; // 50ms tolerance
            return transcriptionData.words.filter(word =>
                word.start >= (block.start - tolerance) &&
                word.end <= (block.end + tolerance)
            );
        }

        return [];
    };

    const toggleBlockExpansion = (blockIndex) => {
        const newExpanded = new Set(expandedBlocks);
        if (newExpanded.has(blockIndex)) {
            newExpanded.delete(blockIndex);
        } else {
            newExpanded.add(blockIndex);
        }
        setExpandedBlocks(newExpanded);
    };


    // Temporary state for drag operations
    const [tempMergeData, setTempMergeData] = useState(null);

    // Handle canvas mouse events
    const handleCanvasMouseDown = (e) => {
        if (enablePanning) {
            isDraggingWaveform.current = true;
            dragStartX.current = e.clientX;
        } else {
            if (!duration || editableBlocks.length === 0) return;

            const canvas = canvasRef.current;
            const rect = canvas.getBoundingClientRect(); // Get current display dimensions

            // Calculate x relative to the canvas's current visible area
            const x = e.clientX - rect.left;

            // getTimeFromX now relies on the latest currentCanvasWidth and scrollOffsetRef.current
            const clickTime = getTimeFromX(x);

            console.log('--- handleCanvasMouseDown Log ---');
            console.log('e.clientX:', e.clientX);
            console.log('rect.left:', rect.left);
            console.log('x (relative to canvas left):', x);
            console.log('scrollOffsetRef.current (at mousedown):', scrollOffsetRef.current);
            console.log('canvas.width (dynamically set):', canvas.width);
            console.log('zoomLevel:', zoomLevel);
            console.log('duration:', duration);
            console.log('Calculated clickTime:', clickTime);
            console.log('--- End handleCanvasMouseDown Log ---');

            // scaleFactor for handle sizes - should be close to 1 if canvas.width matches clientWidth
            const scaleFactor = rect.width / canvas.width;

            // Check if clicking on a block handle (prioritize selected block)
            if (selectedBlockIndex !== null) {
                const block = editableBlocks[selectedBlockIndex];
                const startX = getXFromTime(block.start);
                const endX = getXFromTime(block.end);

                const handleSize = 10 * scaleFactor; // Handles are drawn based on canvas.width, so scaleFactor is still useful here.

                console.log(
                    'data if block is checked',
                    "selected block", selectedBlockIndex,
                    "block start:", block.start, "startX:", startX,
                    "block end:", block.end, "endX:", endX,
                    "x (relative to canvas):", x,
                    "Math.abs(x - startX):", Math.abs(x - startX),
                    "Math.abs(x - endX):", Math.abs(x - endX),
                    "handleSize:", handleSize,
                    "condition (start):", Math.abs(x - startX) <= handleSize,
                    "condition (end):", Math.abs(x - endX) <= handleSize
                );

                // Check start handle of selected block first
                if (Math.abs(x - startX) <= handleSize) {
                    setIsDragging(true);
                    setDragType('start');
                    setTempMergeData({
                        blockIndex: selectedBlockIndex,
                        originalStart: block.start,
                        originalEnd: block.end,
                    });
                    return;
                }

                // Check end handle of selected block
                if (Math.abs(x - endX) <= handleSize) {
                    setIsDragging(true);
                    setDragType('end');
                    setTempMergeData({
                        blockIndex: selectedBlockIndex,
                        originalStart: block.start,
                        originalEnd: block.end,
                    });
                    return;
                }
            }

            // Check all blocks for selection (reverse order to prioritize top blocks)
            for (let i = editableBlocks.length - 1; i >= 0; i--) {
                const block = editableBlocks[i];
                const startX = getXFromTime(block.start);
                const endX = getXFromTime(block.end);

                const handleSize = 10 * scaleFactor;

                console.log(
                    'data', i,
                    "block start:", block.start, "startX:", startX,
                    "block end:", block.end, "endX:", endX,
                    "x (relative to canvas):", x,
                    "Math.abs(x - startX):", Math.abs(x - startX),
                    "Math.abs(x - endX):", Math.abs(x - endX),
                    "handleSize:", handleSize,
                    "condition (start):", Math.abs(x - startX) <= handleSize,
                    "condition (end):", Math.abs(x - endX) <= handleSize
                );

                // Check handles first
                if (Math.abs(x - startX) <= handleSize) {
                    setSelectedBlockIndex(i);
                    console.log('clickTime handleSize start selectedBlockIndex', i);
                    setIsDragging(true);
                    setDragType('start');
                    setTempMergeData({
                        blockIndex: i,
                        originalStart: block.start,
                        originalEnd: block.end,
                    });
                    return;
                }

                if (Math.abs(x - endX) <= handleSize) {
                    setSelectedBlockIndex(i);
                    console.log('clickTime handleSize end selectedBlockIndex', i);
                    setIsDragging(true);
                    setDragType('end');
                    setTempMergeData({
                        blockIndex: i,
                        originalStart: block.start,
                        originalEnd: block.end,
                    });
                    return;
                }

                // Check if clicking inside block
                if (x >= startX && x <= endX) {
                    console.log('clickTime handleSize inside selectedBlockIndex', i);
                    setSelectedBlockIndex(i);
                    return;
                }
            }

            console.log('clickTime handleSize outside selectedBlockIndex', null);

            // If not clicking on a block, seek to time
            setSelectedBlockIndex(null);
            // seekTo(clickTime); // Uncomment if clicking outside blocks should seek
        }
    };

    const handleCanvasMouseMove = (e) => {
        if (enablePanning) {
            const canvas = canvasRef.current;
            if (!canvas) return;
            // Use clientWidth for the current canvas display width
            const currentCanvasDisplayWidth = waveformContainerRef.current ? waveformContainerRef.current.clientWidth : canvas.width;
            const _totalContentWidth = currentCanvasDisplayWidth * zoomLevel;
            const _maxScrollOffset = Math.max(0, _totalContentWidth - currentCanvasDisplayWidth);

            if (
                isDraggingWaveform.current &&
                dragStartX.current !== null
            ) {
                const deltaX = e.clientX - dragStartX.current;
                dragStartX.current = e.clientX;
                setScrollOffset((prev) => {
                    let newOffset = prev - deltaX;
                    newOffset = Math.max(0, Math.min(newOffset, _maxScrollOffset));
                    scrollOffsetRef.current = newOffset; // Immediately update the ref
                    return newOffset;
                });
            }
        } else {
            if (!isDragging || selectedBlockIndex === null) return;

            const canvas = canvasRef.current;
            const rect = canvas.getBoundingClientRect();
            const x = e.clientX - rect.left;

            const newTime = getTimeFromX(x);

            const updatedBlocks = [...editableBlocks];
            const block = updatedBlocks[selectedBlockIndex];

            if (dragType === 'start') {
                block.start = Math.min(newTime, block.end - 0.1); // Ensure minimum block size
            } else if (dragType === 'end') {
                block.end = Math.max(newTime, block.start + 0.1); // Ensure minimum block size
            }

            updatedBlocks[selectedBlockIndex] = { ...block };
            setEditableBlocks(updatedBlocks);
        }
    };

    // Calculate text based on time range from original transcription data
    const calculateTextForTimeRange = useCallback(
        (startTime, endTime) => {
            if (!originalTranscriptionData.length) return '';

            let resultText = '';
            const tolerance = 0.05; // 50ms tolerance for time matching

            // Find all original blocks that overlap with the time range
            const overlappingOriginalBlocks = originalTranscriptionData.filter(
                (originalBlock) => {
                    return !(
                        originalBlock.end <= startTime + tolerance ||
                        originalBlock.start >= endTime - tolerance
                    );
                }
            );

            // Sort by start time
            overlappingOriginalBlocks.sort((a, b) => a.start - b.start);

            // Calculate text contribution from each overlapping block
            overlappingOriginalBlocks.forEach((originalBlock) => {
                const overlapStart = Math.max(startTime, originalBlock.start);
                const overlapEnd = Math.min(endTime, originalBlock.end);
                const overlapDuration = overlapEnd - overlapStart;
                const blockDuration = originalBlock.end - originalBlock.start;

                if (overlapDuration > 0) {
                    const overlapRatio = overlapDuration / blockDuration;

                    // Only include if significant overlap (e.g., at least 10% of original block duration)
                    if (overlapRatio >= 0.1) {
                        const text = originalBlock.originalText || originalBlock.text;

                        if (overlapRatio >= 0.95) {
                            // Include full text if almost complete overlap
                            resultText += (resultText ? ' ' : '') + text;
                        } else {
                            // Calculate partial text based on overlap
                            const startRatio = Math.max(
                                0,
                                (overlapStart - originalBlock.start) / blockDuration
                            );
                            const endRatio = Math.min(
                                1,
                                (overlapEnd - originalBlock.start) / blockDuration
                            );

                            const startChar = Math.floor(startRatio * text.length);
                            const endChar = Math.ceil(endRatio * text.length);

                            const partialText = text.substring(startChar, endChar).trim();
                            if (partialText) {
                                resultText += (resultText ? ' ' : '') + partialText;
                            }
                        }
                    }
                }
            });

            return resultText.trim();
        },
        [originalTranscriptionData]
    );

    const handleCanvasMouseUp = () => {
        if (enablePanning) {
            isDraggingWaveform.current = false;
            dragStartX.current = null;
        } else {
            if (isDragging && selectedBlockIndex !== null && tempMergeData) {
                const updatedBlocks = [...editableBlocks];
                const block = updatedBlocks[selectedBlockIndex];

                // Always recalculate text based on new time range for ANY block
                block.text = calculateTextForTimeRange(block.start, block.end);

                setEditableBlocks(updatedBlocks);
                setHasUnsavedChanges(true);
            }

            setIsDragging(false);
            setDragType(null);
            setTempMergeData(null);
        }
    };


    const handleTextSelection = () => {
        if (customTextRef.current) {
            const start = customTextRef.current.selectionStart;
            const end = customTextRef.current.selectionEnd;
            const text = customTextRef.current.value.substring(start, end);

            setSelectionStart(start);
            setSelectionEnd(end);
            setSelectedText(text);
        }
    };

    // Add new block
    const addNewBlock = () => {
        const newBlock = {
            id: nextBlockId,
            text: 'New Block',
            start: 0.0,
            end: 1.0,
            originalIndex: -1,
            confidence: 1.0,
            isUserAdded: true,
            originalText: 'New Block', // Initial text, will be updated on reorder/resize
        };

        setEditableBlocks([newBlock, ...editableBlocks]);
        setNextBlockId(nextBlockId + 1);
        setHasUnsavedChanges(true);
    };

    // Move block up with proper time adjustment and text recalculation
    const moveBlockUp = (index) => {
        if (index === 0) return; // Can't move first block up

        const updatedBlocks = [...editableBlocks];

        // Simple array swap - no time or text changes
        const temp = updatedBlocks[index];
        updatedBlocks[index] = updatedBlocks[index - 1];
        updatedBlocks[index - 1] = temp;

        setEditableBlocks(updatedBlocks);
        setSelectedBlockIndex(index - 1);
        setHasUnsavedChanges(true);
    };

    // Move block down in list order only (no time/text changes)
    const moveBlockDown = (index) => {
        if (index === editableBlocks.length - 1) return; // Can't move last block down

        const updatedBlocks = [...editableBlocks];

        // Simple array swap - no time or text changes
        const temp = updatedBlocks[index];
        updatedBlocks[index] = updatedBlocks[index + 1];
        updatedBlocks[index + 1] = temp;

        setEditableBlocks(updatedBlocks);
        setSelectedBlockIndex(index + 1);
        setHasUnsavedChanges(true);
    };

    // Quick reorder function
    const handleQuickReorder = () => {
        if (selectedBlockIndex === null) {
            // Using custom alert-like message instead of window.alert()
            setError('Please select a block first');
            return;
        }

        const targetPosition = parseInt(quickReorderPosition);

        // Validate input
        if (
            isNaN(targetPosition) ||
            targetPosition < 1 ||
            targetPosition > editableBlocks.length
        ) {
            setError(`Please enter a valid position between 1 and ${editableBlocks.length}`);
            return;
        }

        // Convert to 0-based index
        const targetIndex = targetPosition - 1;

        if (targetIndex === selectedBlockIndex) {
            // Already at target position
            setQuickReorderPosition('');
            return;
        }

        const updatedBlocks = [...editableBlocks];
        const blockToMove = updatedBlocks[selectedBlockIndex];

        // Remove block from current position
        updatedBlocks.splice(selectedBlockIndex, 1);

        // Insert block at target position
        updatedBlocks.splice(targetIndex, 0, blockToMove);

        setEditableBlocks(updatedBlocks);
        setSelectedBlockIndex(targetIndex);
        setHasUnsavedChanges(true);
        setQuickReorderPosition('');
    };

    // Handle Enter key press in quick reorder input
    const handleQuickReorderKeyPress = (e) => {
        if (e.key === 'Enter') {
            handleQuickReorder();
        }
    };

    // Zoom functions
    const zoomIn = () => {
        const canvas = canvasRef.current;
        if (!canvas) return;
        const currentDisplayWidth = waveformContainerRef.current ? waveformContainerRef.current.clientWidth : canvas.width;

        const _nextZoomLevel = Math.min(zoomLevel * 1.5, 5);
        const _totalNextContentWidth = currentDisplayWidth * _nextZoomLevel;
        const _totalCurrentContentWidth = currentDisplayWidth * zoomLevel;

        // Calculate the percentage of the current scroll offset within the total current content width
        const currentScrollRatio = scrollOffset / _totalCurrentContentWidth;

        // Apply that ratio to the new total content width to find the new scroll offset
        const _scrollerNextOffsetInPixel = currentScrollRatio * _totalNextContentWidth;

        setScrollOffset((prev) => {
            // Ensure the new scroll offset doesn't go negative or past the end of the new content
            const maxScroll = Math.max(0, _totalNextContentWidth - currentDisplayWidth);
            const newOffset = Math.min(Math.max(0, _scrollerNextOffsetInPixel), maxScroll);
            scrollOffsetRef.current = newOffset; // Immediately update the ref
            return newOffset;
        });
        setZoomLevel((prev) => Math.min(prev * 1.5, 5));
    };

    const zoomOut = () => {
        const canvas = canvasRef.current;
        if (!canvas) return;
        const currentDisplayWidth = waveformContainerRef.current ? waveformContainerRef.current.clientWidth : canvas.width;

        const _nextZoomLevel = Math.max(zoomLevel / 1.5, 0.5);
        const _totalNextContentWidth = currentDisplayWidth * _nextZoomLevel;
        const _totalCurrentContentWidth = currentDisplayWidth * zoomLevel;

        // Calculate the percentage of the current scroll offset within the total current content width
        const currentScrollRatio = scrollOffset / _totalCurrentContentWidth;

        // Apply that ratio to the new total content width to find the new scroll offset
        const _scrollerNextOffsetInPixel = currentScrollRatio * _totalNextContentWidth;

        setScrollOffset((prev) => {
            // Ensure the new scroll offset doesn't go negative or past the end of the new content
            const maxScroll = Math.max(0, _totalNextContentWidth - currentDisplayWidth);
            let newOffset = Math.min(Math.max(0, _scrollerNextOffsetInPixel), maxScroll);

            // If zooming out makes the content smaller than the visible area, reset scroll to 0
            if (_totalNextContentWidth <= currentDisplayWidth) {
                newOffset = 0;
            }
            scrollOffsetRef.current = newOffset; // Immediately update the ref
            return newOffset;
        });

        setZoomLevel((prev) => Math.max(prev / 1.5, 1));
    };

    // Upload and transcribe audio
    const uploadAndTranscribe = async (file) => {
        setError('');
        setIsProcessing(true);
        setUploadProgress(0);

        const formData = new FormData();
        formData.append('audio', file);

        try {
            const response = await fetch(`${API_BASE}/transcribe`, {
                method: 'POST',
                body: formData,
            });

            if (!response.ok) {
                throw new Error(`Server error: ${response.status}`);
            }

            const result = await response.json();

            if (result.error) {
                throw new Error(result.error);
            }

            setTranscriptionData(result);
            setUploadProgress(100);
        } catch (error) {
            console.error('Transcription error:', error);
            setError(error.message || 'Failed to transcribe audio');
        } finally {
            setIsProcessing(false);
        }
    };

    // Handle file upload
    const handleFileUpload = async (event) => {
        const file = event.target.files[0];
        if (!file) return;

        // Validate file type
        const allowedTypes = [
            'audio/mpeg',
            'audio/wav',
            'audio/m4a',
            'audio/mp4',
            'audio/ogg',
        ];
        if (!allowedTypes.includes(file.type)) {
            setError('Please upload a valid audio file (MP3, WAV, M4A, MP4, OGG)');
            return;
        }

        // Validate file size (max 100MB)
        if (file.size > 100 * 1024 * 1024) {
            setError('File size must be less than 100MB');
            return;
        }

        setAudioFile(file);
        const url = URL.createObjectURL(file);
        setAudioUrl(url);

        try {
            // Generate waveform
            const waveform = await generateWaveform(file);
            setWaveformData(waveform);

            // Start transcription
            await uploadAndTranscribe(file);
        } catch (error) {
            console.error('Error processing audio:', error);
            setError('Error processing audio file');
        }
    };

    // Audio playback controls
    const togglePlayback = () => {
        if (!audioRef.current) return;

        if (isPlaying) {
            audioRef.current.pause();
        } else {
            audioRef.current.play();
        }
        setIsPlaying(!isPlaying);
    };

    const handleTimeUpdate = () => {
        if (audioRef.current && canvasRef.current) {
            setCurrentTime(audioRef.current.currentTime);

            const canvas = canvasRef.current;
            const currentCanvasDisplayWidth = waveformContainerRef.current ? waveformContainerRef.current.clientWidth : canvas.width;

            // Calculate the pixel position of the current time in the full zoomed waveform
            const timePixelPosition = (audioRef.current.currentTime / duration) * currentCanvasDisplayWidth * zoomLevel;

            // Determine the ideal scroll offset to keep the current time visible,
            // preferably centered or near the center of the canvas.
            const targetScrollOffset = timePixelPosition - (currentCanvasDisplayWidth / 2); // Attempt to center
            const maxScroll = Math.max(0, (currentCanvasDisplayWidth * zoomLevel) - currentCanvasDisplayWidth);

            // Only update scrollOffset if the progress line goes out of view or close to the edge
            const margin = currentCanvasDisplayWidth * 0.1; // 10% margin from edges
            const canvasLeftEdge = scrollOffset;
            const canvasRightEdge = scrollOffset + currentCanvasDisplayWidth;

            // Only adjust scroll if the current time is outside the visible margin
            if (timePixelPosition < canvasLeftEdge + margin || timePixelPosition > canvasRightEdge - margin) {
                setScrollOffset((prev) => {
                    const newOffset = Math.min(Math.max(0, targetScrollOffset), maxScroll);
                    scrollOffsetRef.current = newOffset; // Immediately update the ref
                    return newOffset;
                });
            }
        }
    };

    const handleLoadedMetadata = () => {
        if (audioRef.current) {
            setDuration(audioRef.current.duration);
        }
    };

    const seekTo = (time) => {
        if (audioRef.current) {
            audioRef.current.currentTime = time;
            setCurrentTime(time);
        }
    };

    // Format time display
    const formatTime = (seconds) => {
        const mins = Math.floor(seconds / 60);
        const secs = Math.floor(seconds % 60);
        const ms = Math.floor((seconds % 1) * 1000);
        return `${mins}:${secs.toString().padStart(2, '0')}.${ms
            .toString()
            .padStart(3, '0')}`;
    };

    // Update block time
    const updateBlockTime = (blockIndex, field, value) => {
        const updatedBlocks = [...editableBlocks];
        const numValue = parseFloat(value);

        if (!isNaN(numValue)) {
            if (field === 'start') {
                updatedBlocks[blockIndex].start = Math.max(
                    0,
                    Math.min(numValue, updatedBlocks[blockIndex].end - 0.1)
                );
            } else if (field === 'end') {
                updatedBlocks[blockIndex].end = Math.max(
                    updatedBlocks[blockIndex].start + 0.1,
                    Math.min(numValue, duration)
                );
            }

            // Always recalculate text based on new time range for ANY block
            const block = updatedBlocks[blockIndex];
            block.text = calculateTextForTimeRange(block.start, block.end);

            setEditableBlocks(updatedBlocks);
            setHasUnsavedChanges(true);
        }
    };

    // Update block text
    const updateBlockText = (blockIndex, newText) => {
        const updatedBlocks = [...editableBlocks];
        updatedBlocks[blockIndex].text = newText;
        setEditableBlocks(updatedBlocks);
        setHasUnsavedChanges(true);
    };

    // Delete block
    const deleteBlock = (blockIndex) => {
        const blockToDelete = editableBlocks[blockIndex];
        const updatedBlocks = editableBlocks.filter((_, index) => index !== blockIndex);

        // Store deleted block for undo functionality
        setDeletedBlocks((prev) => [
            ...prev,
            { block: blockToDelete, originalIndex: blockIndex, timestamp: Date.now() },
        ]);

        setEditableBlocks(updatedBlocks);
        setSelectedBlockIndex(null);
        setHasUnsavedChanges(true);
    };

    // Undo delete
    const undoDelete = () => {
        if (deletedBlocks.length === 0) return;

        const lastDeleted = deletedBlocks[deletedBlocks.length - 1];
        const updatedBlocks = [...editableBlocks];

        // Insert the block back at its original position or at the end if position is invalid
        const insertIndex = Math.min(lastDeleted.originalIndex, updatedBlocks.length);
        updatedBlocks.splice(insertIndex, 0, lastDeleted.block);

        setEditableBlocks(updatedBlocks);
        setDeletedBlocks((prev) => prev.slice(0, -1)); // Remove the last deleted block
        setHasUnsavedChanges(true);
    };

    // Save changes
    const saveChanges = () => {

        setOriginalTranscriptionData(
            editableBlocks.map((block) => ({
                id: block.id,
                text: block.text,
                start: block.start,
                end: block.end,
                originalText: block.text, // The 'original' text for this block is now its current text
            }))
        );
        setHasUnsavedChanges(false);
        setDeletedBlocks([]); // Clear undo history when saving
        // You could also save to localStorage or a backend here
    };

    // Reset changes
    const resetChanges = () => {
        // Re-initialize editableBlocks from the true original source (transcriptionData)
        if (transcriptionData) {
            const blocks = getRawDisplayData(transcriptionData).map((item, index) => ({
                id: `block-${index}`,
                text: item.text || item.word,
                start: item.start,
                end: item.end,
                originalIndex: index,
                confidence: item.probability || item.confidence || 0.95,
                isUserAdded: false,
                originalText: item.text || item.word,
            }));
            setEditableBlocks(blocks);
            // Also reset originalTranscriptionData to the initial state
            setOriginalTranscriptionData(
                getRawDisplayData(transcriptionData).map((item, index) => ({
                    id: `original-${index}`,
                    text: item.text || item.word,
                    start: item.start,
                    end: item.end,
                    originalText: item.text || item.word,
                }))
            );
        }
        setHasUnsavedChanges(false);
        setDeletedBlocks([]); // Clear undo history when resetting
    };

    // Export functions
    const exportJSON = () => {
        if (!editableBlocks.length) return;

        // Only export the data for the current view mode
        const exportData = {
            audioFile: audioFile?.name,
            duration: duration,
            viewMode: viewMode,
            [viewMode]: editableBlocks.map((block) => ({
                text: block.text,
                start: block.start,
                end: block.end,
                confidence: block.confidence,
            })),
        };

        const dataStr = JSON.stringify(exportData, null, 2);
        const dataBlob = new Blob([dataStr], { type: 'application/json' });
        const url = URL.createObjectURL(dataBlob);
        const link = document.createElement('a');
        link.href = url;
        link.download = `transcription_${viewMode}_${audioFile?.name || 'audio'}.json`;
        link.click();
        URL.revokeObjectURL(url);
    };


    const exportAudacityLabels = () => {
        let labelContent = '';
        console.log(editableBlocks);
        editableBlocks.forEach((block, index) => {
            labelContent += `${block.start.toFixed(6)}\t${block.end.toFixed(6)}\t${block.text}\n`;
        });

        const blob = new Blob([labelContent], { type: 'text/plain' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `${audioFile.name.split('.')[0]}_${viewMode}_audacity.txt`;
        a.click();
        URL.revokeObjectURL(url);
    };

    const exportSRT = () => {
        if (!editableBlocks.length) return;

        let srtContent = '';
        editableBlocks.forEach((block, index) => {
            const startTime = formatSRTTime(block.start);
            const endTime = formatSRTTime(block.end);
            srtContent += `${index + 1}\n${startTime} --> ${endTime}\n${block.text}\n\n`;
        });

        const dataBlob = new Blob([srtContent], { type: 'text/srt' });
        const url = URL.createObjectURL(dataBlob);
        const link = document.createElement('a');
        link.href = url;
        link.download = `subtitles_${viewMode}_${audioFile?.name || 'audio'}.srt`;
        link.click();
        URL.revokeObjectURL(url);
    };

    const exportSMIL = () => {
        if (!transcriptionData || !audioFile) {
            setError("No transcription data or audio file to export SMIL.");
            return;
        }

        const fileName = audioFile.name.split(".")[0];
        let smilContent = `<?xml version="1.0" encoding="UTF-8"?>\n<smil xmlns="http://www.w3.org/ns/SMIL" version="3.0">\n\t<body>\n`;

        let previousEndTime = 0;

        editableBlocks.forEach((block, index) => {
            const id = `par${index + 1}`;
            const textSrc = `../page-0001.xhtml#SML${index + 1}`;

            // Round to two decimal places and add 's' suffix
            const clipBegin = previousEndTime.toFixed(2) + "s";
            const clipEnd = (previousEndTime + (block.end - block.start)).toFixed(2) + "s";

            smilContent += `\t\t<par id="${id}"><text src="${textSrc}"/><audio src="../audio/${fileName}.mp3" clipBegin="${clipBegin}" clipEnd="${clipEnd}" /></par>\n`;
            previousEndTime += (block.end - block.start);
        });

        smilContent += `\t</body>\n</smil>`;

        const blob = new Blob([smilContent], { type: "application/smil+xml" });
        const url = URL.createObjectURL(blob);
        const link = document.createElement("a");
        link.href = url;
        link.download = `smil_${viewMode}_${fileName}.smil`;
        document.body.appendChild(link);
        link.click();
        document.body.removeChild(link);
        URL.revokeObjectURL(url);

        setError(""); // Clear any previous errors
    };

    //old version with data proper timing for clipbegin and end
    const exportSMIL_old = () => {
        if (!editableBlocks.length) return;

        // Create SMIL XML content
        let smilContent = '<?xml version="1.0" encoding="UTF-8"?>\n';
        smilContent += '<smil xmlns="http://www.w3.org/ns/SMIL" version="3.0">\n';
        smilContent += '\t<body>\n';

        // Add each block as a <par> element
        editableBlocks.forEach((block, index) => {
            const parId = `par${index + 1}`;
            const smlId = `SML${index + 1}`;
            const clipBegin = block.start.toFixed(6);
            const clipEnd = block.end.toFixed(6);

            smilContent += `\t\t<par id="${parId}"><text src="../page-0001.xhtml#${smlId}"/><audio src="../audio/${audioFile?.name || 'audio.mp3'
                }" clipBegin="${clipBegin}" clipEnd="${clipEnd}" /></par>\n`;
        });

        smilContent += '\t</body>\n';
        smilContent += '</smil>';

        const dataBlob = new Blob([smilContent], { type: 'application/smil+xml' });
        const url = URL.createObjectURL(dataBlob);
        const link = document.createElement('a');
        link.href = url;
        link.download = `smil_${viewMode}_${audioFile?.name || 'audio'}.smil`;
        link.click();
        URL.revokeObjectURL(url);
    };




    const formatSRTTime = (seconds) => {
        const hours = Math.floor(seconds / 3600);
        const minutes = Math.floor((seconds % 3600) / 60);
        const secs = Math.floor(seconds % 60);
        const ms = Math.floor((seconds % 1) * 1000);
        return `${hours.toString().padStart(2, '0')}:${minutes
            .toString()
            .padStart(2, '0')}:${secs.toString().padStart(2, '0')},${ms
                .toString()
                .padStart(3, '0')}`;
    };

    useEffect(() => {
        drawWaveform();
    }, [drawWaveform]);

    // Set up ResizeObserver for responsive canvas sizing
    useEffect(() => {
        const canvas = canvasRef.current;
        const container = waveformContainerRef.current;

        const setCanvasDimensions = () => {
            if (canvas && container) {
                // Set canvas's drawing buffer size to match its displayed size
                // This line is crucial for matching internal drawing to external display size
                canvas.width = container.clientWidth;
                canvas.height = 150; // Keep fixed height for now
                drawWaveform(); // Redraw waveform after resize to adapt to new dimensions
            }
        };

        // Set dimensions initially
        setCanvasDimensions();

        // Add resize listener for responsiveness
        // const resizeObserver = new ResizeObserver(setCanvasDimensions);

        if (container) {
            // Observe the parent container for changes in size
            // resizeObserver.observe(container);

            window.addEventListener('resize', setCanvasDimensions)
        }



        return () => {
            if (container) {
                // Clean up the observer when the component unmounts
                // resizeObserver.unobserve(container);
                window.removeEventListener('resize', setCanvasDimensions)
            }
        };
    }, [drawWaveform]);

    useEffect(() => {
        const canvas = canvasRef.current;
        if (canvas) {
            canvas.addEventListener('mousedown', handleCanvasMouseDown);
            canvas.addEventListener('mousemove', handleCanvasMouseMove);
            canvas.addEventListener('mouseup', handleCanvasMouseUp);
            canvas.addEventListener('mouseleave', handleCanvasMouseUp); // Important for drag release outside canvas

            return () => {
                canvas.removeEventListener('mousedown', handleCanvasMouseDown);
                canvas.removeEventListener('mousemove', handleCanvasMouseMove);
                canvas.removeEventListener('mouseup', handleCanvasMouseUp);
                canvas.removeEventListener('mouseleave', handleCanvasMouseUp);
            };
        }
    }, [
        isDragging,
        selectedBlockIndex,
        editableBlocks,
        duration,
        originalTranscriptionData,
        zoomLevel,
        enablePanning,
        // scrollOffset is intentionally NOT here because handleCanvasMouseMove directly updates scrollOffsetRef.current,
        // and this effect is for setting up listeners which should not re-attach on every scroll.
        // The functions themselves (getTimeFromX, getXFromTime) capture `scrollOffsetRef.current` directly.
        getTimeFromX, // Add getXFromTime and getTimeFromX as dependencies to re-create listeners if their dependencies change
        getXFromTime,
    ]);

    return (
        <>
            {/* Bootstrap CSS */}
            <link
                href="https://cdn.jsdelivr.net/npm/bootstrap@5.3.0/dist/css/bootstrap.min.css"
                rel="stylesheet"
                xintegrity="sha384-9ndCyUaIbzAi2FUVXJi0CjmCapSmO7SnpJef0486qhLnuZ2cdeRhO02iuK6FUUVM"
                crossOrigin="anonymous"
            />

            <div
                style={{
                    minHeight: '100vh',
                    background: 'linear-gradient(135deg, #f8f9fa 0%, #e9ecef 100% )',
                }}
            >
                <div className="container-fluid py-4">
                    <div className="row">
                        <div className="col-12">
                            <div className="text-center mb-4">
                                <h1 className="display-5 fw-bold text-dark mb-2">
                                    Audio Transcription Editor
                                </h1>
                                <p className="lead text-muted">
                                    Upload, transcribe, and edit audio with precise timing controls
                                </p>
                            </div>

                            {/* File Upload Card */}
                            <div className="card shadow-sm mb-4">
                                <div className="card-body p-4">
                                    <input
                                        type="file"
                                        accept="audio/*"
                                        onChange={handleFileUpload}
                                        ref={fileInputRef}
                                        className="d-none"
                                    />

                                    {!audioFile ? (
                                        <div
                                            onClick={() => fileInputRef.current?.click()}
                                            className="text-center p-4 border border-2 border-dashed rounded-3"
                                            style={{
                                                cursor: 'pointer',
                                                borderColor: '#dee2e6',
                                                transition: 'all 0.2s',
                                            }}
                                            onMouseEnter={(e) => {
                                                e.target.style.borderColor = '#0d6efd';
                                                e.target.style.backgroundColor = '#f8f9fa';
                                            }}
                                            onMouseLeave={(e) => {
                                                e.target.style.borderColor = '#dee2e6';
                                                e.target.style.backgroundColor = 'transparent';
                                            }}
                                        >
                                            <Upload className="mx-auto mb-3 text-muted" size={40} />
                                            <h5 className="text-muted mb-2">Drop your audio file here</h5>
                                            <p className="text-muted mb-0">or click to browse</p>
                                            <small className="text-muted">
                                                Supports MP3, WAV, M4A, MP4, OGG (max 100MB)
                                            </small>
                                        </div>
                                    ) : (
                                        <div className="row">
                                            {/* Left Column - Waveform */}
                                            <div className="col-lg-8">
                                                <div className="card bg-light mb-3">
                                                    <div className="card-body">
                                                        <div className="d-flex align-items-center justify-content-between mb-3">
                                                            <div className="d-flex align-items-center">
                                                                <FileAudio className="text-primary me-2" size={20} />
                                                                <h6 className="mb-0 fw-semibold">{audioFile.name}</h6>
                                                            </div>
                                                            <div className="d-flex align-items-center gap-2">
                                                                <label className="form-label mb-0 fw-semibold">
                                                                    View:
                                                                </label>
                                                                <select
                                                                    className="form-select form-select-sm"
                                                                    value={viewMode}
                                                                    onChange={(e) => setViewMode(e.target.value)}
                                                                    style={{ width: 'auto' }}
                                                                >
                                                                    <option value="words">Words</option>
                                                                    <option value="sentences">Sentences</option>
                                                                    <option value="paragraphs">Paragraphs</option>
                                                                    <option value="custom">Custom</option>
                                                                </select>
                                                            </div>
                                                        </div>

                                                        <audio
                                                            ref={audioRef}
                                                            src={audioUrl}
                                                            onTimeUpdate={handleTimeUpdate}
                                                            onLoadedMetadata={handleLoadedMetadata}
                                                            onEnded={() => setIsPlaying(false)}
                                                            className="d-none"
                                                        />

                                                        {viewMode !== 'custom' && (
                                                            <>
                                                                {/* Zoom Controls */}
                                                                <div className="d-flex align-items-center justify-content-between mb-2">
                                                                    <div className="btn-group btn-group-sm">
                                                                        <button
                                                                            className="btn btn-outline-secondary"
                                                                            onClick={zoomOut}
                                                                            disabled={zoomLevel <= 0.5}
                                                                            title="Zoom Out"
                                                                        >
                                                                            <ZoomOut size={14} />
                                                                        </button>
                                                                        <button
                                                                            className="btn btn-outline-secondary"
                                                                            onClick={zoomIn}
                                                                            disabled={zoomLevel >= 5}
                                                                            title="Zoom In"
                                                                        >
                                                                            <ZoomIn size={14} />
                                                                        </button>
                                                                    </div>
                                                                    <button
                                                                        className={`btn btn-outline-secondary ${enablePanning ? 'active' : ''}`}
                                                                        onClick={() => setEnablePanning((prev) => !prev)}
                                                                        title="Toggle Panning Mode"
                                                                    >
                                                                        {enablePanning ? 'Disable Panning' : 'Enable Panning'}
                                                                    </button>
                                                                    <small className="text-muted">
                                                                        Zoom: {zoomLevel.toFixed(1)}x
                                                                    </small>
                                                                </div>

                                                                <div
                                                                    ref={waveformContainerRef}
                                                                    className="mb-3"
                                                                    style={{ position: 'relative' }}
                                                                >
                                                                    <canvas
                                                                        ref={canvasRef}
                                                                        // width and height will be set dynamically by useEffect
                                                                        height={150} // Keep this for initial render, or manage fully with JS
                                                                        className="w-100 border rounded bg-white"
                                                                        style={{
                                                                            cursor: enablePanning
                                                                                ? (isDraggingWaveform.current ? 'grabbing' : 'grab')
                                                                                : (isDragging ? 'grabbing' : 'pointer'),
                                                                            userSelect: 'none',
                                                                        }}
                                                                    />
                                                                </div>
                                                            </>
                                                        )}
                                                        {viewMode === 'custom' && (
                                                            <div className="mb-3">
                                                                <div className="card">
                                                                    <div className="card-header bg-info text-white">
                                                                        <h6 className="mb-0">Custom Text Editor</h6>
                                                                        <small>Edit the text and create custom break points</small>
                                                                    </div>
                                                                    <div className="card-body">
                                                                        <div className="mb-3">
                                                                            <label className="form-label fw-semibold">Combined Text:</label>
                                                                            <textarea
                                                                                ref={customTextRef}
                                                                                id="customTextArea"
                                                                                className="form-control"
                                                                                rows="10"
                                                                                value={getCombinedCustomText()}
                                                                                onChange={(e) => updateCombinedCustomText(e.target.value)}
                                                                                onSelect={handleTextSelection}
                                                                                placeholder="Your transcribed text will appear here..."
                                                                            />
                                                                        </div>

                                                                        <div className="d-flex gap-2 mb-3">
                                                                            <button
                                                                                className="btn btn-warning btn-sm"
                                                                                onClick={createCustomBlockFromSelection}
                                                                                disabled={!selectedText}
                                                                                title="Create block from selected text"
                                                                            >
                                                                                <Scissors size={16} className="me-1" />
                                                                                Create Block
                                                                            </button>

                                                                            <button
                                                                                className="btn btn-success"
                                                                                onClick={publishCustomBlocks}
                                                                                disabled={customBlocks.length === 0}
                                                                                title="Publish custom blocks and generate timestamps"
                                                                            >
                                                                                <Send size={16} className="me-1" />
                                                                                Publish
                                                                            </button>
                                                                        </div>

                                                                        {selectedText && (
                                                                            <div className="alert alert-info">
                                                                                <small>
                                                                                    <strong>Selected:</strong> "{selectedText}"
                                                                                </small>
                                                                            </div>
                                                                        )}

                                                                        {/* Custom Blocks Preview */}
                                                                        {customBlocks.length > 0 && (
                                                                            <div className="mt-3">
                                                                                <h6 className="fw-semibold">Current Blocks:</h6>
                                                                                <div className="list-group">
                                                                                    {customBlocks.map((block, index) => (
                                                                                        <div key={block.id} className="list-group-item">
                                                                                            <div className="d-flex justify-content-between align-items-start">
                                                                                                <div className="flex-grow-1">
                                                                                                    <small className="text-muted">Block {index + 1}</small>
                                                                                                    <div className="mt-1">
                                                                                                        <textarea
                                                                                                            className="form-control form-control-sm"
                                                                                                            value={block.text}
                                                                                                            onChange={(e) => updateCustomBlockText(index, e.target.value)}
                                                                                                            rows={2}
                                                                                                        />
                                                                                                    </div>
                                                                                                </div>
                                                                                                <button
                                                                                                    className="btn btn-outline-danger btn-sm ms-2"
                                                                                                    onClick={() => deleteCustomBlock(index)}
                                                                                                    title="Delete block"
                                                                                                >
                                                                                                    <Trash2 size={14} />
                                                                                                </button>
                                                                                            </div>
                                                                                        </div>
                                                                                    ))}
                                                                                </div>
                                                                            </div>
                                                                        )}
                                                                    </div>
                                                                </div>
                                                            </div>
                                                        )}

                                                        <div className="d-flex align-items-center justify-content-between">
                                                            <div className="d-flex align-items-center gap-3">
                                                                <button
                                                                    className="btn btn-primary d-flex align-items-center gap-2"
                                                                    onClick={togglePlayback}
                                                                    disabled={!duration}
                                                                >
                                                                    {isPlaying ? <Pause size={18} /> : <Play size={18} />}
                                                                    {isPlaying ? 'Pause' : 'Play'}
                                                                </button>

                                                                <code className="text-muted">
                                                                    {formatTime(currentTime)} / {formatTime(duration)}
                                                                </code>
                                                            </div>

                                                            {editableBlocks.length > 0 && (
                                                                <div className="btn-group">
                                                                    <button
                                                                        className="btn btn-success btn-sm d-flex align-items-center gap-1"
                                                                        onClick={exportSRT}
                                                                        title="Export SRT subtitles"
                                                                    >
                                                                        <Download size={14} />
                                                                        SRT
                                                                    </button>
                                                                    <button
                                                                        className="btn btn-info btn-sm d-flex align-items-center gap-1 text-white"
                                                                        onClick={exportSMIL}
                                                                        title="Export SMIL XML"
                                                                    >
                                                                        <FileCode size={14} />
                                                                        SMIL
                                                                    </button>
                                                                    <button
                                                                        className="btn btn-secondary btn-sm d-flex align-items-center gap-1"
                                                                        onClick={exportJSON}
                                                                        title="Export JSON data"
                                                                    >
                                                                        <FileJson size={14} />
                                                                        JSON
                                                                    </button>
                                                                    <button
                                                                        className="btn btn-dark btn-sm d-flex align-items-center gap-1"
                                                                        onClick={exportAudacityLabels}
                                                                        title="Export Audacity Labels"
                                                                    >
                                                                        <FileText size={14} />
                                                                        TXT
                                                                    </button>
                                                                </div>
                                                            )}
                                                        </div>
                                                    </div>
                                                </div>
                                            </div>

                                            {/* Right Column - Block Editor */}
                                            {viewMode !== 'custom' && (
                                                <div className="col-lg-4">
                                                    <div className="card">
                                                        <div className="card-header bg-primary text-white d-flex justify-content-between align-items-center">
                                                            <h6 className="mb-0 fw-semibold">
                                                                <Save className="me-2" size={16} />
                                                                Block Editor ({editableBlocks.length} {viewMode})
                                                            </h6>
                                                            <div className="d-flex gap-2">
                                                                {deletedBlocks.length > 0 && (
                                                                    <button
                                                                        className="btn btn-warning btn-sm"
                                                                        onClick={undoDelete}
                                                                        title="Undo last delete"
                                                                    >
                                                                        <Undo size={14} />
                                                                    </button>
                                                                )}
                                                                <button
                                                                    className="btn btn-light btn-sm"
                                                                    onClick={addNewBlock}
                                                                    title="Add new block"
                                                                >
                                                                    <Plus size={14} />
                                                                </button>
                                                                {hasUnsavedChanges && (
                                                                    <div className="btn-group btn-group-sm">
                                                                        <button
                                                                            className="btn btn-light btn-sm"
                                                                            onClick={saveChanges}
                                                                            title="Save changes"
                                                                        >
                                                                            Save
                                                                        </button>
                                                                        <button
                                                                            className="btn btn-outline-light btn-sm"
                                                                            onClick={resetChanges}
                                                                            title="Reset changes"
                                                                        >
                                                                            Reset
                                                                        </button>
                                                                    </div>
                                                                )}
                                                            </div>
                                                        </div>

                                                        {/* Quick Reorder Section */}
                                                        {editableBlocks.length > 0 && (
                                                            <div className="card-body border-bottom bg-light p-3">
                                                                <div className="d-flex align-items-center gap-2">
                                                                    <Hash size={16} className="text-muted" />
                                                                    <label
                                                                        className="form-label mb-0 fw-semibold text-muted"
                                                                        style={{ fontSize: '0.85rem' }}
                                                                    >
                                                                        Quick Reorder:
                                                                    </label>
                                                                    <input
                                                                        type="number"
                                                                        className="form-control form-control-sm"
                                                                        placeholder="Go to block #"
                                                                        value={quickReorderPosition}
                                                                        onChange={(e) => setQuickReorderPosition(e.target.value)}
                                                                        onKeyPress={handleQuickReorderKeyPress}
                                                                        style={{ width: '120px' }}
                                                                    />
                                                                    <button
                                                                        className="btn btn-outline-secondary btn-sm"
                                                                        onClick={handleQuickReorder}
                                                                        title="Reorder block"
                                                                    >
                                                                        Go
                                                                    </button>
                                                                </div>
                                                            </div>
                                                        )}

                                                        <div className="card-body p-0" style={{ maxHeight: '600px', overflowY: 'auto' }}>
                                                            <div className="p-3">
                                                                {editableBlocks.map((block, index) => {
                                                                    const isExpanded = expandedBlocks.has(index);
                                                                    const words = transcriptionData?.words?.filter(word =>
                                                                        word.start >= block.start && word.end <= block.end
                                                                    ) || [];
                                                                    const showWordDetails = (viewMode === 'sentences' || viewMode === 'paragraphs') && words.length > 0;

                                                                    return (
                                                                        <div
                                                                            key={block.id}
                                                                            className={`border-bottom p-3 ${selectedBlockIndex === index
                                                                                ? 'bg-light border-primary'
                                                                                : ''
                                                                                }`}
                                                                            style={{
                                                                                cursor: 'pointer',
                                                                                transition: 'background-color 0.2s',
                                                                                backgroundColor:
                                                                                    selectedBlockIndex === index
                                                                                        ? '#e3f2fd'
                                                                                        : index % 2 === 0
                                                                                            ? '#ffffff'
                                                                                            : '#f8f9fa',
                                                                                borderLeft:
                                                                                    selectedBlockIndex === index
                                                                                        ? '4px solid #0d6efd'
                                                                                        : 'none',
                                                                            }}
                                                                            onClick={() => {
                                                                                setSelectedBlockIndex(index);
                                                                                seekTo(block.start);
                                                                            }}
                                                                        >
                                                                            <div className="d-flex justify-content-between align-items-start mb-2">
                                                                                <div className="d-flex align-items-center">
                                                                                    <small className="text-muted fw-semibold">
                                                                                        Block {index + 1}{' '}
                                                                                        {block.isUserAdded && (
                                                                                            <span className="badge bg-info">New</span>
                                                                                        )}
                                                                                    </small>
                                                                                    {showWordDetails && (
                                                                                        <button
                                                                                            className="btn btn-sm btn-outline-secondary ms-2 p-1"
                                                                                            onClick={(e) => {
                                                                                                e.stopPropagation();
                                                                                                toggleBlockExpansion(index);
                                                                                            }}
                                                                                            title={isExpanded ? "Hide word details" : "Show word details"}
                                                                                            style={{ fontSize: '0.7rem', lineHeight: 1 }}
                                                                                        >
                                                                                            {isExpanded ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
                                                                                            {words.length} words
                                                                                        </button>
                                                                                    )}
                                                                                </div>
                                                                                <div className="btn-group btn-group-sm">
                                                                                    <button
                                                                                        className="btn btn-outline-secondary btn-sm"
                                                                                        onClick={(e) => {
                                                                                            e.stopPropagation();
                                                                                            moveBlockUp(index);
                                                                                        }}
                                                                                        disabled={index === 0}
                                                                                        style={{ padding: '2px 6px' }}
                                                                                        title="Move up"
                                                                                    >
                                                                                        <ArrowUp size={12} />
                                                                                    </button>
                                                                                    <button
                                                                                        className="btn btn-outline-secondary btn-sm"
                                                                                        onClick={(e) => {
                                                                                            e.stopPropagation();
                                                                                            moveBlockDown(index);
                                                                                        }}
                                                                                        disabled={index === editableBlocks.length - 1}
                                                                                        style={{ padding: '2px 6px' }}
                                                                                        title="Move down"
                                                                                    >
                                                                                        <ArrowDown size={12} />
                                                                                    </button>
                                                                                    <button
                                                                                        className="btn btn-outline-danger btn-sm"
                                                                                        onClick={(e) => {
                                                                                            e.stopPropagation();
                                                                                            deleteBlock(index);
                                                                                        }}
                                                                                        style={{ padding: '2px 6px' }}
                                                                                        title="Delete block"
                                                                                    >
                                                                                        <Trash2 size={12} />
                                                                                    </button>
                                                                                </div>
                                                                            </div>

                                                                            <div className="mb-2">
                                                                                <textarea
                                                                                    className="form-control form-control-sm"
                                                                                    value={block.text}
                                                                                    onChange={(e) => {
                                                                                        e.stopPropagation();
                                                                                        updateBlockText(index, e.target.value);
                                                                                    }}
                                                                                    rows={2}
                                                                                    style={{ fontSize: '0.85rem' }}
                                                                                />
                                                                            </div>

                                                                            <div className="row g-2">
                                                                                <div className="col-6">
                                                                                    <label
                                                                                        className="form-label mb-1"
                                                                                        style={{ fontSize: '0.75rem' }}
                                                                                    >
                                                                                        Start Time
                                                                                    </label>
                                                                                    <input
                                                                                        type="number"
                                                                                        className="form-control form-control-sm"
                                                                                        value={block.start.toFixed(3)}
                                                                                        onChange={(e) =>
                                                                                            updateBlockTime(index, 'start', e.target.value)
                                                                                        }
                                                                                        step="0.001"
                                                                                        min="0"
                                                                                        max={duration}
                                                                                        style={{ fontSize: '0.8rem' }}
                                                                                    />
                                                                                </div>
                                                                                <div className="col-6">
                                                                                    <label
                                                                                        className="form-label mb-1"
                                                                                        style={{ fontSize: '0.75rem' }}
                                                                                    >
                                                                                        End Time
                                                                                    </label>
                                                                                    <input
                                                                                        type="number"
                                                                                        className="form-control form-control-sm"
                                                                                        value={block.end.toFixed(3)}
                                                                                        onChange={(e) =>
                                                                                            updateBlockTime(index, 'end', e.target.value)
                                                                                        }
                                                                                        step="0.001"
                                                                                        min="0"
                                                                                        max={duration}
                                                                                        style={{ fontSize: '0.8rem' }}
                                                                                    />
                                                                                </div>
                                                                            </div>

                                                                            {/* Word-level details for sentences and paragraphs */}
                                                                            {showWordDetails && isExpanded && (
                                                                                <div className="mt-3 p-2 bg-light rounded">
                                                                                    <small className="text-muted fw-semibold d-block mb-2">
                                                                                        Word-level timestamps:
                                                                                    </small>
                                                                                    <div className="row g-1">
                                                                                        {words.map((word, wordIndex) => (
                                                                                            <div key={wordIndex} className="col-12">
                                                                                                <div
                                                                                                    className="d-flex justify-content-between align-items-center p-1 rounded"
                                                                                                    style={{
                                                                                                        fontSize: '0.7rem',
                                                                                                        backgroundColor: wordIndex % 2 === 0 ? '#ffffff' : '#f8f9fa',
                                                                                                        cursor: 'pointer'
                                                                                                    }}
                                                                                                    onClick={(e) => {
                                                                                                        e.stopPropagation();
                                                                                                        seekTo(word.start);
                                                                                                    }}
                                                                                                    title={`Click to seek to ${formatTime(word.start)}`}
                                                                                                >
                                                                                                    <span className="fw-semibold text-dark">
                                                                                                        {word.word || word.text}
                                                                                                    </span>
                                                                                                    <span className="text-muted">
                                                                                                        {formatTime(word.start)} - {formatTime(word.end)}
                                                                                                    </span>
                                                                                                </div>
                                                                                            </div>
                                                                                        ))}
                                                                                    </div>
                                                                                    <div className="mt-2 pt-2 border-top">
                                                                                        <small className="text-muted">
                                                                                            <strong>Total:</strong> {formatTime(block.start)} - {formatTime(block.end)}
                                                                                        </small>
                                                                                    </div>
                                                                                </div>
                                                                            )}

                                                                            {block.confidence && (
                                                                                <div className="mt-2">
                                                                                    <small className="text-muted">
                                                                                        Confidence: {(block.confidence * 100).toFixed(1)}%
                                                                                    </small>
                                                                                </div>
                                                                            )}
                                                                        </div>
                                                                    );
                                                                })}
                                                            </div>
                                                        </div>
                                                    </div>
                                                </div>
                                            )}
                                        </div>
                                    )}
                                </div>
                            </div>

                            {error && (
                                <div className="alert alert-danger mb-4" role="alert">
                                    {error}
                                </div>
                            )}

                            {isProcessing && (
                                <div className="card shadow-sm mb-4">
                                    <div className="card-body text-center p-4">
                                        <Loader2
                                            className="animate-spin mx-auto mb-3 text-primary"
                                            size={28}
                                        />
                                        <h6 className="fw-semibold mb-2">Processing Audio with Whisper...</h6>
                                        <p className="text-muted mb-3">
                                            This may take a few minutes depending on file size
                                        </p>
                                        {uploadProgress > 0 && (
                                            <div className="progress" style={{ height: '6px' }}>
                                                <div
                                                    className="progress-bar bg-primary"
                                                    role="progressbar"
                                                    style={{ width: `${uploadProgress}%` }}
                                                    aria-valuenow={uploadProgress}
                                                    aria-valuemin="0"
                                                    aria-valuemax="100"
                                                />
                                            </div>
                                        )}
                                    </div>
                                </div>
                            )}
                        </div>
                    </div>
                </div>
            </div>
        </>
    );
};

export default AudioTranscriptionApp;
