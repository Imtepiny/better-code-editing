if ( 'undefined' === typeof window.wp ) {
	window.wp = {};
}
if ( 'undefined' === typeof window.wp.codeEditor ) {
	window.wp.codeEditor = {};
}

( function( $, wp ) {
	'use strict';

	/**
	 * Default settings for code editor.
	 *
	 * @since 4.9.0
	 * @type {object}
	 */
	wp.codeEditor.defaultSettings = {
		codemirror: {},
		csslint: {},
		htmlhint: {},
		jshint: {},
		onTabNext: function() {},
		onTabPrevious: function() {},
		onChangeLintingErrors: function() {},
		onUpdateErrorNotice: function() {}
	};

	/**
	 * All instances of code editors.
	 *
	 * @since 4.9.0
	 * @type {CodeMirror[]}
	 */
	wp.codeEditor.instances = [];

	/**
	 * Configure linting.
	 *
	 * @param {CodeMirror} editor - Editor.
	 * @param {object}     settings - Code editor settings.
	 * @param {object}     settings.codeMirror - Settings for CodeMirror.
	 * @param {Function}   settings.onChangeLintingErrors - Callback for when there are changes to linting errors.
	 * @param {Function}   settings.onUpdateErrorNotice - Callback to update error notice.
	 * @returns {void}
	 */
	function configureLinting( editor, settings ) { // eslint-disable-line complexity
		var lintOptions = editor.getOption( 'lint' ), currentErrorAnnotations = [], updateErrorNotice, previouslyShownErrorAnnotations = [];
		if ( ! lintOptions ) {
			return;
		}

		if ( true === lintOptions ) {
			lintOptions = {};
		} else {
			lintOptions = $.extend( {}, lintOptions );
		}

		// Note that rules must be sent in the "deprecated" lint.options property to prevent linter from complaining about unrecognized options. See <https://github.com/codemirror/CodeMirror/pull/4944>.
		if ( ! lintOptions.options ) {
			lintOptions.options = {};
		}

		// Configure JSHint.
		if ( 'javascript' === lintOptions.mode && settings.jshint ) {
			$.extend( lintOptions.options, settings.jshint );
		}

		// Configure CSSLint.
		if ( 'css' === lintOptions.mode && settings.csslint ) {
			$.extend( lintOptions.options, settings.csslint );
		}

		// Configure HTMLHint.
		if ( 'htmlmixed' === lintOptions.mode && settings.htmlhint ) {
			lintOptions.options.rules = $.extend( {}, settings.htmlhint );

			if ( settings.jshint ) {
				lintOptions.options.rules.jshint = settings.jshint;
			}
			if ( settings.csslint ) {
				lintOptions.options.rules.csslint = settings.csslint;
			}
		}

		/**
		 * Call the onUpdateErrorNotice if there are new errors to show.
		 *
		 * @returns {void}
		 */
		updateErrorNotice = function() {
			if ( settings.onUpdateErrorNotice && ! _.isEqual( currentErrorAnnotations, previouslyShownErrorAnnotations ) ) {
				settings.onUpdateErrorNotice( currentErrorAnnotations, editor );
				previouslyShownErrorAnnotations = currentErrorAnnotations;
			}
		};

		// Wrap the onUpdateLinting CodeMirror event to route to onChangeLintingErrors and onUpdateErrorNotice.
		lintOptions.onUpdateLinting = (function( onUpdateLintingOverridden ) {
			return function( annotations, annotationsSorted, cm ) {
				var errorAnnotations = _.filter( annotations, function( annotation ) {
					return 'error' === annotation.severity;
				} );

				if ( onUpdateLintingOverridden ) {
					onUpdateLintingOverridden.apply( annotations, annotationsSorted, cm );
				}

				// Skip if there are no changes to the errors.
				if ( _.isEqual( errorAnnotations, currentErrorAnnotations ) ) {
					return;
				}

				currentErrorAnnotations = errorAnnotations;

				if ( settings.onChangeLintingErrors ) {
					settings.onChangeLintingErrors( errorAnnotations, annotations, annotationsSorted, cm );
				}

				/*
				 * Update notifications when the editor is not focused to prevent error message
				 * from overwhelming the user during input, unless there are now no errors or there
				 * were previously errors shown. In these cases, update immediately so they can know
				 * that they fixed the errors.
				 */
				if ( ! cm.state.focused || 0 === currentErrorAnnotations.length || previouslyShownErrorAnnotations.length > 0 ) {
					updateErrorNotice();
				}
			};
		})( lintOptions.onUpdateLinting );

		editor.setOption( 'lint', lintOptions );

		// Update error notice when leaving the editor.
		editor.on( 'blur', updateErrorNotice );

		// Work around hint selection with mouse causing focus to leave editor.
		editor.on( 'startCompletion', function() {
			editor.off( 'blur', updateErrorNotice );
		} );
		editor.on( 'endCompletion', function() {
			var editorRefocusWait = 500;
			editor.on( 'blur', updateErrorNotice );

			// Wait for editor to possibly get re-focused after selection.
			_.delay( function() {
				if ( ! editor.state.focused ) {
					updateErrorNotice();
				}
			}, editorRefocusWait );
		});

		/*
		 * Make sure setting validities are set if the user tries to click Publish
		 * while an autocomplete dropdown is still open. The Customizer will block
		 * saving when a setting has an error notifications on it. This is only
		 * necessary for mouse interactions because keyboards will have already
		 * blurred the field and cause onUpdateErrorNotice to have already been
		 * called.
		 */
		$( document.body ).on( 'mousedown', function( event ) {
			if ( editor.state.focused && ! $.contains( editor.display.wrapper, event.target ) && ! $( event.target ).hasClass( 'CodeMirror-hint' ) ) {
				updateErrorNotice();
			}
		});
	}

	/**
	 * Configure tabbing.
	 *
	 * @param {CodeMirror} codemirror - Editor.
	 * @param {object}     settings - Code editor settings.
	 * @param {object}     settings.codeMirror - Settings for CodeMirror.
	 * @param {Function}   settings.onTabNext - Callback to handle tabbing to the next tabbable element.
	 * @param {Function}   settings.onTabPrevious - Callback to handle tabbing to the previous tabbable element.
	 * @returns {void}
	 */
	function configureTabbing( codemirror, settings ) {
		var $textarea = $( codemirror.getTextArea() );

		codemirror.on( 'blur', function() {
			$textarea.data( 'next-tab-blurs', false );
		});
		codemirror.on( 'focus', function() {
			if ( codemirror.display.wrapper.scrollIntoViewIfNeeded ) {
				codemirror.display.wrapper.scrollIntoViewIfNeeded();
			} else {
				codemirror.display.wrapper.scrollIntoView();
			}
		});
		codemirror.on( 'keydown', function onKeydown( editor, event ) {
			var tabKeyCode = 9, escKeyCode = 27;

			// Take note of the ESC keypress so that the next TAB can focus outside the editor.
			if ( escKeyCode === event.keyCode ) {
				$textarea.data( 'next-tab-blurs', true );
				return;
			}

			// Short-circuit if tab key is not being pressed or the tab key press should move focus.
			if ( tabKeyCode !== event.keyCode || ! $textarea.data( 'next-tab-blurs' ) ) {
				return;
			}

			// Focus on previous or next focusable item.
			if ( event.shiftKey ) {
				settings.onTabPrevious( codemirror, event );
			} else {
				settings.onTabNext( codemirror, event );
			}

			// Reset tab state.
			$textarea.data( 'next-tab-blurs', false );

			// Prevent tab character from being added.
			event.preventDefault();
		});
	}

	/**
	 * Initialize Code Editor (CodeMirror) for an existing textarea.
	 *
	 * @since 4.9.0
	 *
	 * @param {string|jQuery|Element} textarea - The HTML id, jQuery object, or DOM Element for the textarea that is used for the editor.
	 * @param {object}                [settings] - Settings to override defaults.
	 * @param {Function}              [settings.onChangeLintingErrors] - Callback for when the linting errors have changed.
	 * @param {Function}              [settings.onUpdateErrorNotice] - Callback for when error notice should be displayed.
	 * @param {Function}              [settings.onTabPrevious] - Callback to handle tabbing to the previous tabbable element.
	 * @param {Function}              [settings.onTabNext] - Callback to handle tabbing to the next tabbable element.
	 * @param {object}                [settings.codemirror] - Options for CodeMirror.
	 * @param {object}                [settings.csslint] - Rules for CSSLint.
	 * @param {object}                [settings.htmlhint] - Rules for HTMLHint.
	 * @param {object}                [settings.jshint] - Rules for JSHint.
	 * @returns {CodeMirror} CodeMirror instance.
	 */
	wp.codeEditor.initialize = function initialize( textarea, settings ) {
		var $textarea, codemirror, instanceSettings, instance;
		if ( 'string' === typeof textarea ) {
			$textarea = $( '#' + textarea );
		} else {
			$textarea = $( textarea );
		}

		instanceSettings = $.extend( {}, wp.codeEditor.defaultSettings, settings );
		instanceSettings.codemirror = $.extend( {}, instanceSettings.codemirror );

		codemirror = wp.CodeMirror.fromTextArea( $textarea[0], instanceSettings.codemirror );

		configureLinting( codemirror, instanceSettings );

		instance = {
			settings: instanceSettings,
			codemirror: codemirror
		};

		// Keep track of the instances that have been created.
		wp.codeEditor.instances.push( instance );

		if ( codemirror.showHint ) {
			codemirror.on( 'keyup', function( editor, event ) { // eslint-disable-line complexity
				var shouldAutocomplete, isAlphaKey = /^[a-zA-Z]$/.test( event.key ), lineBeforeCursor, innerMode, token;
				if ( codemirror.state.completionActive && isAlphaKey ) {
					return;
				}

				// Prevent autocompletion in string literals or comments.
				token = codemirror.getTokenAt( codemirror.getCursor() );
				if ( 'string' === token.type || 'comment' === token.type ) {
					return;
				}

				innerMode = wp.CodeMirror.innerMode( codemirror.getMode(), token.state ).mode.name;
				lineBeforeCursor = codemirror.doc.getLine( codemirror.doc.getCursor().line ).substr( 0, codemirror.doc.getCursor().ch );
				if ( 'html' === innerMode || 'xml' === innerMode ) {
					shouldAutocomplete =
						'<' === event.key ||
						'/' === event.key && 'tag' === token.type ||
						isAlphaKey && 'tag' === token.type ||
						isAlphaKey && 'attribute' === token.type ||
						'=' === token.string && token.state.htmlState && token.state.htmlState.tagName;
				} else if ( 'css' === innerMode ) {
					shouldAutocomplete =
						isAlphaKey ||
						':' === event.key ||
						' ' === event.key && /:\s+$/.test( lineBeforeCursor );
				} else if ( 'javascript' === innerMode ) {
					shouldAutocomplete = isAlphaKey || '.' === event.key;
				} else if ( 'clike' === innerMode && 'application/x-httpd-php' === codemirror.options.mode ) {
					shouldAutocomplete = 'keyword' === token.type || 'variable' === token.type;
				}
				if ( shouldAutocomplete ) {
					codemirror.showHint( { completeSingle: false } );
				}
			});
		}

		// Facilitate tabbing out of the editor.
		configureTabbing( codemirror, settings );

		return instance;
	};

})( window.jQuery, window.wp );
