We start with the ground everything else stands on. You already hold half of it — you told me JSON is the universal language between clients and servers. Here's the full truth, one level wider:

ALL communication between a web client and a web server is plain text, in a fixed format called HTTP. Not objects, not binary magic — ordinary text, exactly as if two people were exchanging carefully formatted letters.

You've already seen this without knowing it. When you set up a request in Postman, you fill in fields. Those fields aren't a Postman invention — they're the parts of the text message Postman will build for you. A raw request, as the server actually receives it, looks like this:


POST /chat HTTP/1.1
Host: myserver.com
Content-Type: application/json
Authorization: Bearer abc123

{"country": "japan", "message": "hello"}
Read it as three zones:


Zone	Lines here	What it answers
Start line	POST /chat HTTP/1.1	What do you want to do, and where? (method + path)
Headers	Host:, Content-Type:, Authorization:	Context about the request — who you are, what format the body is in
Body	{"country": "japan", ...}	The actual data — this is the JSON you already know
The server answers with the same shape, mirrored:


HTTP/1.1 200 OK
Content-Type: application/json

{"reply": "hello from the bot"}
The number up top is the status code — the server's one-word summary of what happened. You've met these already in your own code: 200 = success, 400 = "your request was malformed", 401 = "you're not authorized". They're not Flask things — they're part of the HTTP text format itself, which is why Postman shows them for any server in the world.

You can verify all of this yourself right now: in Postman, send any request to your server, then click Code (top right, </> icon) and pick "HTTP" — it shows you the raw text your pretty Postman form was generating all along.

That's the foundation: envelope, headers, body, status code. Check your understanding: