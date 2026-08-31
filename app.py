import gevent.monkey
gevent.monkey.patch_all()

from flask import Flask, request, jsonify
from flask_cors import CORS
from flask_socketio import SocketIO, join_room, leave_room, emit
from pymongo import MongoClient
import os
import random
import time
import gevent

app = Flask(__name__)
CORS(app)

socketio = SocketIO(app, cors_allowed_origins="*")

MONGO_URI = os.environ.get('MONGO_URI', 'mongodb://localhost:27017/')

try:
    client = MongoClient(MONGO_URI, connect=False)
    db = client['wallgo_db']
    users_col = db['users']
    history_col = db['history']
    friends_col = db['friends']
    print("✅ 成功連線至 MongoDB 資料庫！")
except Exception as e:
    print(f"❌ MongoDB 連線失敗: {e}")

# ================= 記憶體資料區 =================
rooms = {}

# ================= 帳號 API =================
@app.route('/api/register', methods=['POST'])
def register():
    data = request.json
    user_id = data.get('id')
    username = data.get('username')
    password = data.get('password')

    if users_col.find_one({"id": user_id}):
        return jsonify({"success": False, "message": "此 ID 已被註冊！"})

    new_user = {
        "id": user_id,
        "username": username,
        "password": password,
        "avatar": username[0].upper(),
        "is_online": 1
    }
    users_col.insert_one(new_user)
    
    return jsonify({
        "success": True, 
        "message": "註冊成功！",
        "user": {"id": user_id, "name": username, "avatar": username[0].upper()}
    })

@app.route('/api/login', methods=['POST'])
def login():
    data = request.json
    user_id = data.get('id')
    password = data.get('password')

    user = users_col.find_one({"id": user_id})
    if user:
        if user['password'] == password: 
            users_col.update_one({"id": user_id}, {"$set": {"is_online": 1}})
            return jsonify({
                "success": True, 
                "message": "登入成功",
                "user": {"id": user['id'], "name": user['username'], "avatar": user['avatar']}
            })
        else:
            return jsonify({"success": False, "message": "密碼錯誤"})
    else:
        return jsonify({"success": False, "message": "找不到此玩家 ID"})

@app.route('/api/reset_password', methods=['POST'])
def reset_password():
    data = request.json
    user_id = data.get('id')
    new_password = data.get('new_password')
    
    user = users_col.find_one({"id": user_id})
    if user:
        users_col.update_one({"id": user_id}, {"$set": {"password": new_password}})
        return jsonify({"success": True, "message": "密碼重設成功！請使用新密碼重新登入。"})
    else:
        return jsonify({"success": False, "message": "找不到此玩家 ID！請確認輸入正確。"})

@app.route('/api/update_profile', methods=['POST'])
def update_profile():
    data = request.json
    user_id = data.get('id')
    new_username = data.get('username')
    new_avatar = data.get('avatar')
    
    user = users_col.find_one({"id": user_id})
    if user:
        users_col.update_one(
            {"id": user_id}, 
            {"$set": {"username": new_username, "avatar": new_avatar}}
        )
        return jsonify({"success": True, "message": "個人資料更新成功！"})
    else:
        return jsonify({"success": False, "message": "找不到此玩家 ID！"})

# ================= 戰績 API =================
@app.route('/api/save_history', methods=['POST'])
def save_history():
    data = request.json
    history_col.insert_one({
        "user_id": data.get('user_id'),
        "date": data.get('date'),
        "winner": data.get('winner'),
        "winScore": data.get('winScore'),
        "details": data.get('details'),
        "replayData": data.get('replayData', "")
    })
    return jsonify({"success": True, "message": "戰績儲存成功"})

@app.route('/api/get_history', methods=['POST'])
def get_history():
    data = request.json
    user_id = data.get('user_id')
    records = list(history_col.find({"user_id": user_id}, {"_id": 0}))
    return jsonify({"success": True, "history": records})

@app.route('/api/clear_history', methods=['POST'])
def clear_history():
    data = request.json
    user_id = data.get('user_id')
    history_col.delete_many({"user_id": user_id})
    return jsonify({"success": True})


# ================= 好友系統 API =================
@app.route('/api/send_friend_request', methods=['POST'])
def send_friend_request():
    data = request.json
    requester_id = data.get('requester_id')
    receiver_id = data.get('receiver_id')

    if requester_id == receiver_id:
        return jsonify({"success": False, "message": "不能加自己為好友喔！"})

    receiver = users_col.find_one({"id": receiver_id})
    if not receiver:
        return jsonify({"success": False, "message": "找不到此玩家 ID！請確認輸入正確。"})

    existing = friends_col.find_one({
        "$or": [
            {"requester_id": requester_id, "receiver_id": receiver_id},
            {"requester_id": receiver_id, "receiver_id": requester_id}
        ]
    })

    if existing:
        if existing['status'] == 'accepted':
            return jsonify({"success": False, "message": "你們已經是好友了！"})
        else:
            return jsonify({"success": False, "message": "邀請已存在！請至好友列表查看狀態。"})

    friends_col.insert_one({
        "requester_id": requester_id,
        "receiver_id": receiver_id,
        "status": "pending" 
    })
    return jsonify({"success": True, "message": "好友邀請已送出！等待對方同意。"})

@app.route('/api/get_friends', methods=['POST'])
def get_friends():
    data = request.json
    user_id = data.get('user_id')

    relations = friends_col.find({
        "$or": [{"requester_id": user_id}, {"receiver_id": user_id}]
    })

    friends_list, pending_sent, pending_received = [], [], []

    for rel in relations:
        other_id = rel['receiver_id'] if rel['requester_id'] == user_id else rel['requester_id']
        other_user = users_col.find_one({"id": other_id})
        if not other_user:
            continue
        
        user_info = {
            "id": other_user['id'], 
            "name": other_user['username'], 
            "avatar": other_user['avatar']
        }

        if rel['status'] == 'accepted':
            friends_list.append(user_info)
        elif rel['status'] == 'pending':
            if rel['requester_id'] == user_id:
                pending_sent.append(user_info) 
            else:
                pending_received.append(user_info) 
    
    return jsonify({
        "success": True, 
        "friends": friends_list,
        "pending_sent": pending_sent,
        "pending_received": pending_received
    })

@app.route('/api/handle_friend_request', methods=['POST'])
def handle_friend_request():
    data = request.json
    requester_id = data.get('requester_id') 
    receiver_id = data.get('receiver_id')   
    action = data.get('action')

    if action == 'accept':
        friends_col.update_one(
            {"requester_id": requester_id, "receiver_id": receiver_id},
            {"$set": {"status": "accepted"}}
        )
        return jsonify({"success": True, "message": "已同意好友請求！"})
    elif action == 'reject':
        friends_col.delete_one({"requester_id": requester_id, "receiver_id": receiver_id})
        return jsonify({"success": True, "message": "已拒絕該請求！"})
    
    return jsonify({"success": False, "message": "無效的操作"})

# ================= 💡 後端遊戲引擎核心邏輯 =================
# 將原本前端的 AI 與狀態推演移至後端集中處理
boardSize = 13
allColors = ['red', 'blue', 'yellow', 'green']

def init_game_state(room_code, player_count):
    activeColors = allColors[:player_count]
    placementQueue = activeColors + activeColors[::-1]
    
    playersInfo = {}
    playerTimes = {}
    for c in activeColors:
        playersInfo[c] = {"hasBreaker": True}
        playerTimes[c] = 90
        
    state = {
        'phase': 'placement',
        'turnIndex': 0,
        'activeColors': activeColors,
        'placementQueue': placementQueue,
        'movementOrder': activeColors.copy(),
        'pieces': [],
        'walls': [], # list of {"r":r, "c":c, "color":color}
        'territories': [],
        'playersInfo': playersInfo,
        'playerTimes': playerTimes,
        'selectedPieceIndex': -1,
        'movedPieceIndex': -1,
        'stepsTaken': 0,
        'timer_job': None # 用於儲存倒數計時協程
    }
    return state

def get_piece_index(pieces, r, c):
    for i, p in enumerate(pieces):
        if p['r'] == r and p['c'] == c:
            return i
    return -1

def has_wall_between(walls, r1, c1, r2, c2):
    if r1 == r2 and c1 == c2: return False
    wallR = (r1 + r2) / 2
    wallC = (c1 + c2) / 2
    for w in walls:
        if w['r'] == wallR and w['c'] == wallC:
            return True
    return False

def get_valid_moves(pieces, walls, startR, startC):
    valid_moves = []
    for r in range(0, boardSize, 2):
        for c in range(0, boardSize, 2):
            dr = abs(startR - r)
            dc = abs(startC - c)
            if (dr == 2 and dc == 0) or (dr == 0 and dc == 2) or (dr == 0 and dc == 0):
                if get_piece_index(pieces, r, c) == -1 or (r == startR and c == startC):
                    if not has_wall_between(walls, startR, startC, r, c):
                        valid_moves.append({'r': r, 'c': c})
    return valid_moves

def get_valid_walls(walls, pR, pC):
    valid_walls = []
    dirs = [[-1, 0], [1, 0], [0, -1], [0, 1]]
    for dr, dc in dirs:
        wr, wc = pR + dr, pC + dc
        if 0 <= wr < boardSize and 0 <= wc < boardSize:
            is_empty = True
            for w in walls:
                if w['r'] == wr and w['c'] == wc:
                    is_empty = False
                    break
            if is_empty:
                valid_walls.append({'r': wr, 'c': wc})
    return valid_walls

def evaluate_board(pieces, walls, aiColor):
    score = 0
    aiMobility = 0
    oppMobility = 0
    for p in pieces:
        moves_count = len(get_valid_moves(pieces, walls, p['r'], p['c']))
        if p['color'] == aiColor:
            aiMobility += moves_count
            score -= (abs(p['r'] - 6) + abs(p['c'] - 6)) * 0.5
        else:
            oppMobility += moves_count
    
    score += (aiMobility * 2.5) - oppMobility
    if aiMobility == 0: score -= 10000
    return score

def force_ai_move(room_code):
    """後端強制代打邏輯"""
    if room_code not in rooms or 'game_state' not in rooms[room_code]: return
    state = rooms[room_code]['game_state']
    
    if state['phase'] == 'game_over': return
    
    color = state['placementQueue'][state['turnIndex']] if state['phase'] == 'placement' else state['movementOrder'][state['turnIndex']]
    
    # 執行 AI 邏輯
    if state['phase'] == 'placement':
        empty_cells = []
        for r in range(0, boardSize, 2):
            for c in range(0, boardSize, 2):
                if get_piece_index(state['pieces'], r, c) == -1:
                    empty_cells.append({'r': r, 'c': c})
        if empty_cells:
            choice = random.choice(empty_cells)
            state['pieces'].append({'color': color, 'r': choice['r'], 'c': choice['c']})
        
        state['turnIndex'] += 1
        if state['turnIndex'] >= len(state['placementQueue']):
            state['phase'] = 'movement'
            state['turnIndex'] = 0
            
    elif state['phase'] == 'wall_building':
        p = state['pieces'][state['movedPieceIndex']]
        possible_walls = get_valid_walls(state['walls'], p['r'], p['c'])
        if possible_walls:
            w = random.choice(possible_walls)
            state['walls'].append({'r': w['r'], 'c': w['c'], 'color': color})
            
        state['movedPieceIndex'] = -1
        state['selectedPieceIndex'] = -1
        state['stepsTaken'] = 0
        state['phase'] = 'movement'
        state['turnIndex'] = (state['turnIndex'] + 1) % len(state['movementOrder'])
        
    else: # movement / breaking
        my_pieces = [{'idx': i, **p} for i, p in enumerate(state['pieces']) if p['color'] == color]
        total_mobility = sum(len(get_valid_moves(state['pieces'], state['walls'], p['r'], p['c'])) for p in my_pieces)
        
        my_walls = [w for w in state['walls'] if w['color'] == color]
        if state['playersInfo'][color]['hasBreaker'] and my_walls and (total_mobility <= 2 or state['phase'] == 'wall_breaking'):
            w_to_break = random.choice(my_walls)
            state['walls'].remove(w_to_break)
            state['playersInfo'][color]['hasBreaker'] = False

        best_action = None
        best_score = -float('inf')

        for p in my_pieces:
            moves = get_valid_moves(state['pieces'], state['walls'], p['r'], p['c'])
            for m in moves:
                old_r, old_c = p['r'], p['c']
                state['pieces'][p['idx']]['r'] = m['r']
                state['pieces'][p['idx']]['c'] = m['c']
                
                v_walls = get_valid_walls(state['walls'], m['r'], m['c'])
                for w in v_walls:
                    test_wall = {'r': w['r'], 'c': w['c'], 'color': color}
                    state['walls'].append(test_wall)
                    score = evaluate_board(state['pieces'], state['walls'], color) + random.random() * 0.1
                    if score > best_score:
                        best_score = score
                        best_action = {'pIdx': p['idx'], 'mr': m['r'], 'mc': m['c'], 'wr': w['r'], 'wc': w['c']}
                    state['walls'].remove(test_wall)
                
                state['pieces'][p['idx']]['r'] = old_r
                state['pieces'][p['idx']]['c'] = old_c

        if best_action:
            state['pieces'][best_action['pIdx']]['r'] = best_action['mr']
            state['pieces'][best_action['pIdx']]['c'] = best_action['mc']
            state['walls'].append({'r': best_action['wr'], 'c': best_action['wc'], 'color': color})
        else:
            if my_pieces:
                fallback_p = my_pieces[0]
                w_moves = get_valid_walls(state['walls'], fallback_p['r'], fallback_p['c'])
                if w_moves:
                    state['walls'].append({'r': w_moves[0]['r'], 'c': w_moves[0]['c'], 'color': color})
                    
        state['movedPieceIndex'] = -1
        state['selectedPieceIndex'] = -1
        state['stepsTaken'] = 0
        state['phase'] = 'movement'
        state['turnIndex'] = (state['turnIndex'] + 1) % len(state['movementOrder'])

    # 恢復秒數並通知所有人
    state['playerTimes'][color] = 90
    check_end_game(room_code)
    socketio.emit('update_board', get_clean_state(state), to=room_code)
    socketio.emit('receive_chat', {'user_name': '系統', 'color': 'yellow', 'message': f'⏳ {color} 逾時，伺服器已強制代為結算。'}, to=room_code)

def check_end_game(room_code):
    """檢查是否遊戲結束的伺服器邏輯"""
    state = rooms[room_code]['game_state']
    if state['phase'] == 'placement': return
    
    gameOver = False
    scores = {c: 0 for c in state['activeColors']}
    visited = set()
    hasMixedTerritory = False
    territories = []

    for r in range(0, boardSize, 2):
        for c in range(0, boardSize, 2):
            pos_str = f"{r},{c}"
            if pos_str in visited: continue
            
            queue = [{'r': r, 'c': c}]
            visited.add(pos_str)
            regionSize = 0
            colorsInRegion = set()
            regionCells = []

            while queue:
                curr = queue.pop(0)
                regionSize += 1
                regionCells.append(curr)
                
                p_idx = get_piece_index(state['pieces'], curr['r'], curr['c'])
                if p_idx != -1:
                    colorsInRegion.add(state['pieces'][p_idx]['color'])

                dirs = [[-2, 0, -1, 0], [2, 0, 1, 0], [0, -2, 0, -1], [0, 2, 0, 1]]
                for dr, dc, wr, wc in dirs:
                    nr, nc = curr['r'] + dr, curr['c'] + dc
                    w_r, w_c = curr['r'] + wr, curr['c'] + wc
                    n_str = f"{nr},{nc}"
                    
                    if 0 <= nr < boardSize and 0 <= nc < boardSize:
                        if not any(w['r'] == w_r and w['c'] == w_c for w in state['walls']):
                            if n_str not in visited:
                                visited.add(n_str)
                                queue.append({'r': nr, 'c': nc})
                                
            if len(colorsInRegion) > 1:
                hasMixedTerritory = True
            elif len(colorsInRegion) == 1:
                color = list(colorsInRegion)[0]
                scores[color] += regionSize
                for cell in regionCells:
                    territories.append([f"{cell['r']},{cell['c']}", color])
                    
    anyPlayerCanMove = False
    for color in state['activeColors']:
        my_walls = [w for w in state['walls'] if w['color'] == color]
        if state['playersInfo'][color]['hasBreaker'] and my_walls:
            anyPlayerCanMove = True
            break
            
        playerPieces = [p for p in state['pieces'] if p['color'] == color]
        for p in playerPieces:
            moves = get_valid_moves(state['pieces'], state['walls'], p['r'], p['c'])
            for m in moves:
                if get_valid_walls(state['walls'], m['r'], m['c']):
                    anyPlayerCanMove = True
                    break
            if anyPlayerCanMove: break
        if anyPlayerCanMove: break
        
    if not hasMixedTerritory or not anyPlayerCanMove:
        state['phase'] = 'game_over'
        state['territories'] = territories
        if state['timer_job']:
            state['timer_job'].kill()

def room_timer_loop(room_code):
    """後端集中倒數計時協程"""
    while True:
        gevent.sleep(1)
        if room_code not in rooms or 'game_state' not in rooms[room_code]:
            break
            
        state = rooms[room_code]['game_state']
        if state['phase'] == 'game_over':
            break
            
        currentColor = state['placementQueue'][state['turnIndex']] if state['phase'] == 'placement' else state['movementOrder'][state['turnIndex']]
        
        state['playerTimes'][currentColor] -= 1
        
        if state['playerTimes'][currentColor] <= 0:
            force_ai_move(room_code)
        else:
            # 每秒同步一次剩餘時間給所有前端
            socketio.emit('sync_time', {'playerTimes': state['playerTimes']}, to=room_code)

def get_clean_state(state):
    """移除不能序列化的協程物件後傳給前端"""
    return {k: v for k, v in state.items() if k != 'timer_job'}

# ================= 即時連線 (WebSocket) 房間系統 =================
@socketio.on('create_room')
def handle_create_room(data):
    room_code = data.get('room_code')
    user_info = data.get('user_info')
    join_room(room_code)
    rooms[room_code] = {'players': [user_info], 'status': 'waiting'}
    emit('room_created', {'room_code': room_code, 'players': rooms[room_code]['players']})

@socketio.on('join_room')
def handle_join_room(data):
    room_code = data.get('room_code')
    user_info = data.get('user_info')
    if room_code in rooms:
        if rooms[room_code].get('status') == 'playing':
            emit('join_error', {'message': '遊戲已經開始，請稍候或加入其他房間！'})
            return

        if len(rooms[room_code]['players']) >= 4:
            emit('join_error', {'message': '房間已滿！不能再加入了。'})
        else:
            if not any(p['id'] == user_info['id'] for p in rooms[room_code]['players']):
                join_room(room_code)
                rooms[room_code]['players'].append(user_info)
            emit('room_updated', {'room_code': room_code, 'players': rooms[room_code]['players']}, to=room_code)
    else:
        emit('join_error', {'message': '找不到此房間！請確認代碼是否正確。'})

@socketio.on('leave_room')
def handle_leave_room(data):
    room_code = data.get('room_code')
    user_id = data.get('user_id')
    if room_code in rooms:
        leave_room(room_code)
        rooms[room_code]['players'] = [p for p in rooms[room_code]['players'] if p['id'] != user_id]
        if len(rooms[room_code]['players']) == 0:
            if 'game_state' in rooms[room_code] and rooms[room_code]['game_state']['timer_job']:
                rooms[room_code]['game_state']['timer_job'].kill()
            del rooms[room_code]
        else:
            emit('room_updated', {'room_code': room_code, 'players': rooms[room_code]['players']}, to=room_code)

@socketio.on('start_game')
def handle_start_game(data):
    room_code = data.get('room_code')
    if room_code in rooms:
        rooms[room_code]['status'] = 'playing'
        player_count = len(rooms[room_code]['players'])
        
        # 💡 啟動後端權威狀態與計時器
        rooms[room_code]['game_state'] = init_game_state(room_code, player_count)
        rooms[room_code]['game_state']['timer_job'] = gevent.spawn(room_timer_loop, room_code)
        
        emit('game_started', {'room_code': room_code, 'player_count': player_count}, to=room_code)

@socketio.on('join_game_room')
def handle_join_game_room(data):
    room_code = data.get('room_code')
    user_id = data.get('user_id')
    join_room(room_code)
    
    my_color = None
    room_players = {} 
    
    if room_code in rooms:
        players = rooms[room_code]['players']
        colors = ['red', 'blue', 'yellow', 'green']
        
        for i, p in enumerate(players):
            if i < len(colors):
                room_players[colors[i]] = p['name']
                if p['id'] == user_id:
                    my_color = colors[i]
                    
        # 將當前後端狀態一併下發給剛加入的玩家
        current_state = None
        if 'game_state' in rooms[room_code]:
            current_state = get_clean_state(rooms[room_code]['game_state'])
    
    emit('init_game', {'my_color': my_color, 'room_players': room_players, 'initial_state': current_state})

@socketio.on('game_action')
def handle_game_action(data):
    """
    💡 前端不再全權負責廣播，前端只把動作更新上來
    後端更新主狀態後，重新下發給所有人，確保全場同步！
    """
    room_code = data.get('room_code')
    if room_code in rooms and 'game_state' in rooms[room_code]:
        state = rooms[room_code]['game_state']
        
        # 將前端發來的更新同步到後端記憶體
        state['pieces'] = data.get('pieces', [])
        state['walls'] = [{'r': int(k.split(',')[0]), 'c': int(k.split(',')[1]), 'color': v} for k, v in data.get('walls', [])]
        state['territories'] = data.get('territories', [])
        state['phase'] = data.get('phase')
        state['turnIndex'] = data.get('turnIndex')
        state['movedPieceIndex'] = data.get('movedPieceIndex')
        state['selectedPieceIndex'] = data.get('selectedPieceIndex')
        state['stepsTaken'] = data.get('stepsTaken')
        state['playersInfo'] = data.get('playersInfo', state['playersInfo'])
        state['playerTimes'] = data.get('playerTimes', state['playerTimes'])
        
        check_end_game(room_code)
        
        # 下發給所有人 (包含操作者自己，確保強制覆蓋一致狀態)
        emit('update_board', get_clean_state(state), to=room_code)

@socketio.on('send_chat')
def handle_send_chat(data):
    room_code = data.get('room_code')
    emit('receive_chat', data, to=room_code, include_self=False)

if __name__ == '__main__':
    socketio.run(app, host='0.0.0.0', port=5000, debug=True)