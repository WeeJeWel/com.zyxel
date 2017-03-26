'use strict';

const http = require('http');
const querystring = require('querystring');
const events = require('events');

const DEFAULT_POLL_INTERVAL = 10000;

class Zyxel extends events.EventEmitter {

	constructor( ip, username, password ) {
		super();

		this._ip = ip;
		this._username = username;
		this._password = password;

		this._session = undefined;
		this._getConnectedClientsPoll = false;
		this._getConnectedClientsInterval = undefined;
		this._getConnectedClientsCache = undefined;
		this._getConnectedClientsPending = false;

	}

	get( path, body ) {

		return new Promise(( resolve, reject ) => {

			if( typeof this._session !== 'string' )
				return this.login()
					.then( () => {
						this.get( path, body )
							.then( resolve )
							.catch( reject );
					})
					.catch( reject );

			let req = http.request({
				method: 'GET',
				host: this._ip,
				path: path,
				headers: {
					'Cookie': `SESSION=${this._session}`
				}
			}, ( res ) => {

				let body = '';
				res
					.on('data', ( chunk ) => {
						body += chunk;
					})
					.on('end', () => {

						// check if session has expired
						if( body.indexOf(`top.location='/login/login.html';`) > -1 )
							return this.login()
								.then( () => {
									this.get( path, body )
										.then( resolve )
										.catch( reject );
								})
								.catch( reject );

						resolve( body );
					})

			});
			req.on('error', reject);
			req.end();

		});

	}

	login() {

		return new Promise(( resolve, reject ) => {

			let reqBody = querystring.stringify({
				 'AuthName': this._username,
				 'AuthPassword': this._password
			});

			let req = http.request({
				method: 'POST',
				host: this._ip,
				path: `/login/login-page.cgi`,
				headers: {
					'Content-Type': `application/x-www-form-urlencoded`,
					'Content-Length': reqBody.length
				}
			}, ( res ) => {

				let resBody = '';
				res
					.on('data', ( chunk ) => {
						resBody += chunk;
					})
					.on('end', () => {
						if( resBody.indexOf(`top.location='/index.html';`) > -1 ) {
							try {
								this._session = res.headers['set-cookie'][0].split(';')[0].split('=')[1];
								resolve();
							} catch( err ) {
								reject( err );
							}

						} else {
							reject( new Error('invalid_credentials') );
						}
					})

			});
			req.write( reqBody );
			req.end();

		});
	}

	getTrafficStatusWan( opts ) {

		return new Promise(( resolve, reject ) => {

			return this.get('/pages/systemMonitoring/trafficStatus/wan.html')
				.then( body => {

					try {
						let txTotal = body.match(/var txTotal\ \=\ \'(.*?)';/);
						let rxTotal = body.match(/var rxTotal\ \=\ \'(.*?)';/);

						if( txTotal === null
						 || rxTotal === null )
						 	return reject( new Error('unexpected_response') );

						resolve({
							rxTotal: parseInt(rxTotal[1]),
							txTotal: parseInt(txTotal[1])
						});
					} catch( err ) {
						reject( err );
					}

				})
				.catch( reject );

		});

	}

	getConnectedClients() {

		return new Promise(( resolve, reject ) => {

			return this.get('/pages/connectionStatus/content/networkMap.html')
				.then( body => {

					try {
						let clients = {};

						let users = {
							wired: body.match(/var wiredActiveUsers\ \=\ \'(.*?)';/),
							wlan: body.match(/var wlActiveUsers\ \=\ \'(.*?)';/)
						}

						for( let connection in users ) {
							users[connection][1]
								.split('|')
								.map( user => {
									return user.split('/');
								})
								.forEach( user => {
									clients[ user[3] ] ={
										connection: connection,
										type: user[0],
										name: user[1],
										lease: user[2],
										mac: user[3],
										ip: user[5]
									}
								});
						}

						resolve( clients );

					} catch( err ) {
						reject( err );
					}

				})
				.catch( reject );

		});
	}

	enableConnectedClientsPoll( delay ) {

		if( this._getConnectedClientsInterval )
			clearInterval(this._getConnectedClientsInterval);

		let timeout = ( typeof delay === 'number' ) ? delay : DEFAULT_POLL_INTERVAL;
		this._getConnectedClientsInterval = setInterval(this._getConnectedClientsGetInterval.bind(this), timeout);
	}

	disableConnectedClientsPoll() {
		if( this._getConnectedClientsInterval )
			clearInterval(this._getConnectedClientsInterval);
		this._getConnectedClientsPoll = undefined;
	}

	_getConnectedClientsGetInterval() {

		if( this._getConnectedClientsPending ) return;
			this._getConnectedClientsPending = true;

		this.getConnectedClients()
			.then( clients => {

				this._getConnectedClientsPending = false;

				if( typeof this._getConnectedClientsCache !== 'undefined' ) {

					// find connected clients
					for( let mac in clients ) {
						if( typeof this._getConnectedClientsCache[ mac ] === 'undefined' ) {
							this.emit('client_connect', clients[mac]);
						}
					}

					// find disconnected clients
					for( let mac in this._getConnectedClientsCache ) {
						if( typeof clients[ mac ] === 'undefined' ) {
							this.emit('client_disconnect', this._getConnectedClientsCache[mac]);
						}
					}

				}

				this._getConnectedClientsCache = clients;

			})
			.catch( err => {
				this._getConnectedClientsPending = false;
				reject( err );
			})


	}

}

module.exports = Zyxel;

// test from cli
if( process.argv.length > 2 ) {

	var z = new Zyxel('192.168.0.1', process.argv[2], process.argv[3]);
		z.login()
			.then(() => {
				z.on('client_connect', console.log.bind( null, 'client_connect') );
				z.on('client_disconnect', console.log.bind( null, 'client_disconnect') );
				z.enableConnectedClientsPoll( 1000 );
				z.getTrafficStatusWan()
					.then( console.log )
					.catch( console.error );
				z.getConnectedClients()
					.then( ( clients ) => {
						console.log(`${Object.keys(clients).length} connected clients`);
					})
					.catch( console.error );

			})
			.catch( console.error );
}