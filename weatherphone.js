#!/bin/env node
(function WeatherPhone () {
	var fs = require('fs');
	var client = require('ari-client');
	var request = require('request');

	var AWS = require('aws-sdk');


	// Read in a config file
	var config = {};

	try {
		config = JSON.parse(
			fs.readFileSync('config.json')
		);
	} catch (err) {
		console.log('ERROR: Could not read configuration file config.json!');
		process.exit(1);
	}



	AWS.config.update({region: config.aws_region});

	var polly = new AWS.Polly();

	client.connect(config.asterisk_http_url, config.asterisk_ari_username, config.asterisk_ari_password)
		.then(
			function handler(ari) { 

				var sessions = {};

				ari.on('StasisStart',
					function channelJoined(event, channel) {
						channel.answer()
							.then( 
								function() {
									console.log('Answered incoming channel %s from %s (%s)...', channel.id, channel.caller.number, channel.caller.name);
									sessions[channel.id] = { zipcode : '' };								
								}
							)
							.then(function () { return getRemoteSpeech('wp-'+channel.id+'-greeting', 'Thank you for calling. This service is powered by Weather Underground and Amazon Web Services. Please enter your five digit zip code to hear current conditions and the three day forecast.'); } )
							.then(function (fileName) { return play(channel, fileName); } );
							// .then(
							// 	function () {
							// 		console.log('Hanging up...');
							// 		channel.hangup();
							// 	}
							// );
					}
				);

				ari.on('ChannelDtmfReceived',
					function dtmfHandler(event, channel) {
						console.log('DTMF Event on channel %s: %s', channel.id, event.digit);
		
						sessions[channel.id].zipcode = sessions[channel.id].zipcode + event.digit;
						if (sessions[channel.id].zipcode.length === 5) {
							console.log('Got zip code %s for channel %s', sessions[channel.id].zipcode, channel.id);
							doWeatherReport(sessions[channel.id].zipcode, channel);
							sessions[channel.id].zipcode = '';
						}
					}
				);

				ari.on('ChannelHangupRequest',
					function hangupHandler(event, channel) {
						console.log('Hangup requested by channel %s', channel.id);
						delete sessions[channel.id];
					}
				);

				ari.on('ChannelDestroyed',
					function hangupHandler(event, channel) {
						console.log('Channel %s destroyed', channel.id);
					}
				);


				// **** Utility Functions 
				function doWeatherReport(zipcode, channel) {
					var weather = {};
					return new Promise(
						function getConditions (resolve, reject) {
							return getRemoteJSON('http://api.wunderground.com/api/' + config.wunderground_api_key + '/conditions/q/'+zipcode+'.json')
								.then(
									function(payload) {
										weather.conditions = payload.current_observation;
										return resolve();
									}
								);
						}
					)
					.then(
						function getForecast() {
							return getRemoteJSON('http://api.wunderground.com/api/' + config.wunderground_api_key + '/forecast/q/'+zipcode+'.json')
								.then(
									function(payload) {
										weather.forecast = payload.forecast.txt_forecast;
										return true;
									}
								);
						}
					)
					.then(
						function renderCurrentConditions() {
							console.log('doWeatherReport()>renderCurrentConditions(): Entering renderCurrentConditions()...'); 
							return getRemoteSpeech('wp-'+channel.id+'-'+zipcode+'-conditions', 
								'Currently in ' + weather.conditions.display_location.full +
								', it is ' + weather.conditions.weather + 
								', with a temperature of ' + weather.conditions.temp_f + 
								' and relative humidity of ' + weather.conditions.relative_humidity + 
								'. The wind is ' + weather.conditions.wind_string + '.'
							); 
						} 
					)
					.then(function playConditions (fileName) { return play(channel, fileName); } )
					.then(
						function renderForecast() {
							console.log('doWeatherReport()>renderForecast(): Entering renderForecast()...'); 

							promises = [];
							for (i=1; i<=4; i++) {
								promises.push(getRemoteSpeech('wp-'+channel.id+'-'+zipcode+'-forecast-'+i, 
									weather.forecast.forecastday[i].title + '. ' +
									weather.forecast.forecastday[i].fcttext
								));
							}

							return Promise.all(promises);
						} 
					)
					.then(function () { return play(channel, 'wp-'+channel.id+'-'+zipcode+'-forecast-1'); } )
					.then(function () { return play(channel, 'wp-'+channel.id+'-'+zipcode+'-forecast-2'); } )
					.then(function () { return play(channel, 'wp-'+channel.id+'-'+zipcode+'-forecast-3'); } )
					.then(function () { return play(channel, 'wp-'+channel.id+'-'+zipcode+'-forecast-4'); } );
				}

				function getRemoteJSON (url) {
					return new Promise(
						function getCurrentConditions(resolve, reject) {
							console.log('getRemoteJSON(): Calling URL %s...', url);
							request(url, 
								function handler (err, response, body) {
									if (!err && response.statusCode === 200) {
										console.log('getRemoteJSON(): Call succeeded.');
										resolve(JSON.parse(body));
									} else {
										reject(err);
									}
								}
							);
						}
					);
				}

				function getRemoteSpeech(fileName, text) {
					console.log('getRemoteSpeech(): Entering getRemoteSpeech()...');
					return new Promise(
						function streamFromPolly(resolve, reject) {
							var params = {
								OutputFormat: 'pcm',
								VoiceId: 'Joanna',
								Text: text,
							};

							console.log('getRemoteSpeech()>streamFromPolly(): Requesting speech stream from AWS Polly...');
							polly.synthesizeSpeech(params,
								function(err, data) {
									if (err) {
										reject(err);
									} else {
										console.log('getRemoteSpeech()>streamFromPolly(): Returning audio stream...');
										resolve(data);
									}
								}
							);
						}
					)
					.then(
						function saveStreamToFile(data) {
							return new Promise(
								function (resolve, reject) {
									console.log('getRemoteSpeech()>saveStreamToFile(): Preparing to write file...');
									fs.writeFile('/mnt/sounds/'+fileName+'.sln16', data.AudioStream,
										function handler (err) {
											if (err) {
												reject(err);
											} else {
												console.log('getRemoteSpeech()>saveStreamToFile(): Wrote auto stream to disk as %s...', fileName);
												resolve(fileName);
											}
										}
									);
								}
							);
						}
					);
				}

				function play (channel, fileName) {
					var playback = ari.Playback();

					console.log('play(): Asking Asterisk to play file %s...', fileName);
					sound = 'sound:/mnt/sounds/' + fileName;

					return new Promise(
						function (resolve, reject) {
							playback.on('PlaybackFinished', 
								function (event, playback) {
									console.log('play(): Playback has completed.');
									resolve(playback);
								}
							);

							channel.play({media: sound}, playback)
						.catch(
							function (err) {
								reject(err);
							});
						}
					);
				}

				ari.start('aws-polly-weatherphone');
			}
		)
		.catch(
			function(err) {
				console.log(err);
			}
		);
})();